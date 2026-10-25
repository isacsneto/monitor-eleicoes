#!/usr/bin/env python3
"""
Build historical election-night timelines (2nd round, President) from TSE
open data, for the monitor-eleicoes dashboard.

Outputs data/history/<year>.json (see README in the report / parent code).

Sources (TSE dados abertos, cdn.tse.jus.br):
  * Boletim de Urna "bweb" 2nd round, one zip per UF (bweb_2t_<UF>_*.zip)
      2022 has DT_BU_RECEBIDO (BU reception time for totalization, Brasilia).
      2018 has no reception time -> estimated (see estimate_2018_times()).
  * votacao_partido_munzona_<year>.zip (file *_BR.csv) -> 1st round per UF.
  * Historico_Totalizacao_Presidente_BR_2T_2022.zip (optional, only used as a
    cross-check of the reconstructed 2022 national curve).

Usage (from project root):
  python -I scripts/build_history.py                 # download missing + build 2022 and 2018
  python -I scripts/build_history.py --year 2022     # only one year
  python -I scripts/build_history.py --no-download   # use what is in data/raw/<year>/

Raw downloads go to data/raw/<year>/ (gitignored). Zips are stream-read, never
extracted. The 2018 build also needs the 2022 BU files (for the delay model).
"""
import argparse
import bisect
import csv
import datetime as dt
import glob
import io
import json
import os
import statistics
import sys
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CKAN = "https://dadosabertos.tse.jus.br/api/3/action/package_show?id="
ODSELE = "https://cdn.tse.jus.br/estatistica/sead/odsele"

YEARS = {
    2022: {
        "date": "2022-10-30",
        "left": {"n": "13", "nome": "LULA", "partido": "PT"},
        "right": {"n": "22", "nome": "JAIR BOLSONARO", "partido": "PL"},
        "official": {"left": 60345999, "right": 58206354},
        "extra": ["https://cdn.tse.jus.br/estatistica/sead/eleicoes/eleicoes2022/"
                  "Historico_Totalizacao_Presidente_BR_2T_2022.zip"],
    },
    2018: {
        "date": "2018-10-28",
        "left": {"n": "13", "nome": "FERNANDO HADDAD", "partido": "PT"},
        "right": {"n": "17", "nome": "JAIR BOLSONARO", "partido": "PSL"},
        "official": {"left": 47040906, "right": 57797847},
        "extra": [],
    },
}
TZ = "-03:00"
csv.field_size_limit(10_000_000)


# ----------------------------------------------------------------- download
def bu_urls(year):
    with urllib.request.urlopen(CKAN + f"resultados-{year}-boletim-de-urna", timeout=60) as r:
        d = json.load(r)
    return [x["url"].strip() for x in d["result"]["resources"]
            if x["url"].lower().endswith(".zip") and "_2t_" in x["url"].lower()]


def fetch(url, dest_dir):
    dest = os.path.join(dest_dir, url.rsplit("/", 1)[1])
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest, "cached"
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dest)
    return dest, "downloaded"


def download(year):
    d = os.path.join(ROOT, "data", "raw", str(year))
    os.makedirs(d, exist_ok=True)
    urls = bu_urls(year)
    urls.append(f"{ODSELE}/votacao_partido_munzona/votacao_partido_munzona_{year}.zip")
    urls.append(f"{ODSELE}/detalhe_votacao_munzona/detalhe_votacao_munzona_{year}.zip")
    urls += YEARS[year]["extra"]
    with ThreadPoolExecutor(max_workers=6) as ex:
        for dest, st in ex.map(lambda u: fetch(u, d), urls):
            if st == "downloaded":
                print("  downloaded", os.path.basename(dest), file=sys.stderr)


# ------------------------------------------------------------------ parsing
def csv_rows(zpath, name_filter=lambda n: n.lower().endswith(".csv")):
    with zipfile.ZipFile(zpath) as z:
        names = [i.filename for i in z.infolist() if name_filter(i.filename)]
        for n in names:
            with z.open(n) as raw:
                f = io.TextIOWrapper(raw, encoding="latin-1", newline="")
                r = csv.reader(f, delimiter=";")
                h = [c.replace(" ", "").strip() for c in next(r)]
                ix = {c: i for i, c in enumerate(h)}
                for row in r:
                    yield ix, row


def parse_dt(s):
    """'30/10/2022 17:34:43' -> naive datetime (None if null)."""
    s = s.strip()
    if len(s) < 19 or s.startswith("#"):
        return None
    return dt.datetime(int(s[6:10]), int(s[3:5]), int(s[0:2]),
                       int(s[11:13]), int(s[14:16]), int(s[17:19]))


def read_bu(year, left_n, right_n):
    """Return {key: section dict}; key = (uf, mun, zona, secao) (ints except uf)."""
    d = os.path.join(ROOT, "data", "raw", str(year))
    files = sorted(glob.glob(os.path.join(d, "[Bb][Ww][Ee][Bb]_2t_*.zip")))
    if len(files) != 28:
        raise SystemExit(f"{year}: expected 28 bweb_2t zips in {d}, found {len(files)}")
    secs = {}
    for fn in files:
        for ix, row in csv_rows(fn):
            if row[ix["CD_CARGO_PERGUNTA"]].strip() != "1":
                continue
            uf = row[ix["SG_UF"]].strip().lower()
            key = (uf, int(row[ix["CD_MUNICIPIO"]]), int(row[ix["NR_ZONA"]]),
                   int(row[ix["NR_SECAO"]]))
            s = secs.get(key)
            if s is None:
                s = secs[key] = {
                    "l": 0, "r": 0,
                    "tipo": row[ix["DS_TIPO_URNA"]].strip().upper(),
                    "enc": parse_dt(row[ix["DT_ENCERRAMENTO"]]),
                    "recv": parse_dt(row[ix["DT_BU_RECEBIDO"]]) if "DT_BU_RECEBIDO" in ix else None,
                }
            nv = row[ix["NR_VOTAVEL"]].strip()
            if nv == left_n:
                s["l"] += int(row[ix["QT_VOTOS"]])
            elif nv == right_n:
                s["r"] += int(row[ix["QT_VOTOS"]])
    return secs


def read_t1(year, left_n, right_n):
    d = os.path.join(ROOT, "data", "raw", str(year))
    zp = os.path.join(d, f"votacao_partido_munzona_{year}.zip")
    t1 = {}
    for ix, row in csv_rows(zp, lambda n: n.endswith(f"_{year}_BR.csv")):
        if row[ix["CD_CARGO"]].strip() != "1" or row[ix["NR_TURNO"]].strip() != "1":
            continue
        uf = row[ix["SG_UF"]].strip().lower()
        v = int(row[ix["QT_VOTOS_NOMINAIS_VALIDOS"]]) + int(row[ix["QT_VOTOS_LEGENDA_VALIDOS"]])
        e = t1.setdefault(uf, {"left": 0, "right": 0, "vv": 0})
        p = row[ix["NR_PARTIDO"]].strip()
        if p == left_n:
            e["left"] += v
        elif p == right_n:
            e["right"] += v
        e["vv"] += v
    br = {"left": 0, "right": 0, "vv": 0}
    for e in t1.values():
        for k in br:
            br[k] += e[k]
    t1 = dict(sorted(t1.items()))
    t1["br"] = br
    return t1


def read_secoes(year):
    """Official number of (principal) sections per UF in the 2nd round, incl.
    sections not installed (absent from the BU files)."""
    zp = os.path.join(ROOT, "data", "raw", str(year), f"detalhe_votacao_munzona_{year}.zip")
    out = {}
    for ix, row in csv_rows(zp, lambda n: n.endswith(f"_{year}_BR.csv")):
        if row[ix["CD_CARGO"]].strip() != "1" or row[ix["NR_TURNO"]].strip() != "2":
            continue
        uf = row[ix["SG_UF"]].strip().lower()
        out[uf] = out.get(uf, 0) + int(row[ix["QT_SECOES_PRINCIPAIS"]])
    return out


# ------------------------------------------------------- 2018 time estimate
def estimate_2018_times(secs18, secs22):
    """2018 BUs have no reception timestamp. Estimate:
         t_recv(2018) = DT_ENCERRAMENTO(2018, urn local clock)
                        + [DT_BU_RECEBIDO(2022, Brasilia) - DT_ENCERRAMENTO(2022, local)]
       using the same section (uf, municipio, zona, secao) in 2022. The 2022
       delay embeds the local->Brasilia offset, so the result is Brasilia time.
       Fallbacks: median delay of same zona, then municipio, then UF.
       Missing 2018 DT_ENCERRAMENTO -> median encerramento of the municipio."""
    delay = {}
    by_zona, by_mun, by_uf = {}, {}, {}
    for k, s in secs22.items():
        if s["recv"] and s["enc"]:
            dl = (s["recv"] - s["enc"]).total_seconds()
            if -6 * 3600 < dl < 30 * 3600:
                delay[k] = dl
                by_zona.setdefault(k[:3], []).append(dl)
                by_mun.setdefault(k[:2], []).append(dl)
                by_uf.setdefault(k[0], []).append(dl)
    med = lambda L: statistics.median(L)
    mz = {k: med(v) for k, v in by_zona.items()}
    mm = {k: med(v) for k, v in by_mun.items()}
    mu = {k: med(v) for k, v in by_uf.items()}
    enc_mun = {}
    for k, s in secs18.items():
        if s["enc"]:
            enc_mun.setdefault(k[:2], []).append(s["enc"])
    enc_mun_med = {k: sorted(v)[len(v) // 2] for k, v in enc_mun.items()}
    stats = {"secao": 0, "zona": 0, "mun": 0, "uf": 0, "none": 0, "enc_fallback": 0}
    for k, s in secs18.items():
        if s["tipo"] in ("NÃO INSTALADA", "NÃO APURADA", "ANULADA"):
            s["recv"] = None
            stats["none"] += 1
            continue
        enc = s["enc"]
        if enc is None:
            enc = enc_mun_med.get(k[:2])
            stats["enc_fallback"] += 1
        if enc is None:
            s["recv"] = None
            stats["none"] += 1
            continue
        if k in delay:
            dl, src = delay[k], "secao"
        elif k[:3] in mz:
            dl, src = mz[k[:3]], "zona"
        elif k[:2] in mm:
            dl, src = mm[k[:2]], "mun"
        else:
            dl, src = mu[k[0]], "uf"
        stats[src] += 1
        s["recv"] = enc + dt.timedelta(seconds=dl)
    return stats


# ------------------------------------------------------------ build timeline
def build(year, secs, t1, official_secs, extra_notes, source):
    cfg = YEARS[year]
    ufs = sorted({k[0] for k in secs})
    secoes = {u: 0 for u in ufs}
    final = {u: {"left": 0, "right": 0, "vv": 0} for u in ufs}
    events = []  # (time, uf, l, r)
    pending = []  # sections without a time: only in final entry
    open_t = dt.datetime.fromisoformat(cfg["date"] + "T17:00:00")
    for k, s in secs.items():
        uf = k[0]
        secoes[uf] += 1
        valid = s["tipo"] != "ANULADA"  # annulled urn: votes not totalized
        l, r = (s["l"], s["r"]) if valid else (0, 0)
        final[uf]["left"] += l
        final[uf]["right"] += r
        if s["recv"] is None:
            pending.append((uf, l, r))
        else:
            # totalization opened at 17:00 Brasilia (earlier BUs from abroad wait)
            events.append((max(s["recv"], open_t), uf, l, r))
    for u in ufs:
        final[u]["vv"] = final[u]["left"] + final[u]["right"]
        # sections missing from the BU files (not installed): counted in final entry only
        missing = official_secs.get(u, 0) - secoes[u]
        if missing > 0:
            print(f"[{year}]   {u}: {missing} official section(s) absent from BU (nao instaladas)")
            secoes[u] += missing
            pending.extend([(u, 0, 0)] * missing)
    secoes["br"] = sum(secoes[u] for u in ufs)
    final["br"] = {k: sum(final[u][k] for u in ufs) for k in ("left", "right", "vv")}
    total = secoes["br"]

    events.sort()
    cum = {u: [0, 0, 0, 0] for u in ufs}
    timeline = []
    n_done = 0
    i = 0
    last_t = events[-1][0] if events else open_t

    def snap(t):
        uf = {u: list(v) for u, v in cum.items()}
        uf["br"] = [sum(cum[u][j] for u in ufs) for j in range(4)]
        return {"t": t.strftime("%Y-%m-%dT%H:%M:%S") + TZ, "uf": uf}

    step = dt.timedelta(minutes=1)
    while i < len(events) and n_done < 0.999 * total:
        t0 = events[i][0].replace(second=0)
        # coarsen to 2-min buckets after 99% (keeps file small)
        width = step * (2 if n_done >= 0.99 * total else 1)
        tend = t0 + width
        while i < len(events) and events[i][0] < tend:
            _, uf, l, r = events[i]
            c = cum[uf]
            c[0] += 1; c[1] += l; c[2] += r; c[3] += l + r
            n_done += 1
            i += 1
        timeline.append(snap(tend))
    # final entry: everything
    for _, uf, l, r in events[i:]:
        c = cum[uf]; c[0] += 1; c[1] += l; c[2] += r; c[3] += l + r
    for uf, l, r in pending:
        c = cum[uf]; c[0] += 1; c[1] += l; c[2] += r; c[3] += l + r
    tfin = max(last_t.replace(second=0) + step,
               dt.datetime.fromisoformat(timeline[-1]["t"][:19]) + step)
    timeline.append(snap(tfin))

    out = {
        "year": year,
        "date": cfg["date"],
        "left": cfg["left"],
        "right": cfg["right"],
        "source": source,
        "notes": extra_notes,
        "t1": t1,
        "secoes": secoes,
        "final": final,
        "timeline": timeline,
    }
    return out


def report(year, out, secs):
    cfg = YEARS[year]
    fb = out["final"]["br"]
    ok = fb["left"] == cfg["official"]["left"] and fb["right"] == cfg["official"]["right"]
    print(f"[{year}] final.br left={fb['left']:,} right={fb['right']:,} "
          f"official left={cfg['official']['left']:,} right={cfg['official']['right']:,} "
          f"-> {'MATCH' if ok else 'MISMATCH'}")
    print(f"[{year}] secoes.br={out['secoes']['br']:,}  t1.br={out['t1']['br']}  "
          f"timeline entries={len(out['timeline'])}  "
          f"first={out['timeline'][0]['t']} last={out['timeline'][-1]['t']}")
    tot = out["secoes"]["br"]
    lead = None
    marks = [0.01, 0.1, 0.25, 0.5, 0.67, 0.75, 0.9, 0.99, 0.999]
    mi = 0
    for e in out["timeline"]:
        n, l, r, _ = e["uf"]["br"]
        p = n / tot
        cur = "left" if l > r else "right"
        if lead is not None and cur != lead:
            print(f"[{year}]   lead change -> {cur} at {e['t']} with {p:.2%} sections "
                  f"(L {l/(l+r):.2%} x R {r/(l+r):.2%})")
        lead = cur
        while mi < len(marks) and p >= marks[mi]:
            print(f"[{year}]   {marks[mi]:>6.1%} sections at {e['t']}  L {l/(l+r):.2%}  R {r/(l+r):.2%}")
            mi += 1


def crosscheck_2022(out):
    zp = os.path.join(ROOT, "data", "raw", "2022", "Historico_Totalizacao_Presidente_BR_2T_2022.zip")
    if not os.path.exists(zp):
        return
    hist = []
    for ix, row in csv_rows(zp):
        if row[ix["SG_UE_UF"]].strip() != "BR":
            continue
        t = parse_dt(row[ix["DT_TOTALIZACAO"]])
        hist.append((t, int(row[ix["QT_SECOES_TOT_ACUMULADO"]]),
                     int(row[ix["LULA_QT_VOTOS_TOT_ACUMULADO"]]),
                     int(row[ix["JAIR_BOLSONARO_QT_VOTOS_TOT_ACUMULADO"]])))
    hist.sort()
    times = [h[0] for h in hist]
    print("[2022] cross-check vs official Historico_Totalizacao (BR):")
    for e in out["timeline"][::30] + [out["timeline"][-1]]:
        t = dt.datetime.fromisoformat(e["t"][:19])
        j = bisect.bisect_right(times, t) - 1
        if j < 0:
            continue
        h = hist[j]
        n, l, r, _ = e["uf"]["br"]
        print(f"   {e['t'][11:16]}  ours: {n:>7,} secs L {l/(l+r) if l+r else 0:.2%} | "
              f"official: {h[1]:>7,} secs L {h[2]/(h[2]+h[3]) if h[2]+h[3] else 0:.2%}")
    # crossover in official data
    lead = None
    for h in hist:
        cur = "lula" if h[2] > h[3] else "bolsonaro"
        if lead and cur != lead:
            print(f"   official lead change -> {cur} at {h[0]} with {h[1]/472075:.2%} sections")
        lead = cur


# --------------------------------------------------------------------- main
NOTES_2022 = (
    "Linha do tempo reconstruída a partir dos boletins de urna (bweb 2º turno, cargo Presidente): "
    "cada seção entra no minuto do seu DT_BU_RECEBIDO (horário de Brasília, recebimento do BU para "
    "totalização). BUs do exterior recebidos antes das 17:00 foram agrupados às 17:00 (abertura da "
    "totalização). Cada ponto da linha do tempo representa o acumulado de BUs recebidos até o instante "
    "'t' (o horário de divulgação real pode ter defasagem de segundos/minutos). Seção = seção principal "
    "(agregadas não contam à parte); secoes = QT_SECOES_PRINCIPAIS do TSE (detalhe_votacao_munzona), "
    "472.075 no total. As 47 seções não instaladas (ausentes dos BUs) e 1 urna ANULADA (ZZ, 0 votos) só "
    "entram como contadas na última entrada. Buckets de 1 min até 99%, de 2 min entre 99% e 99,9%; última "
    "entrada contém tudo. validVotes = votos nominais dos 2 candidatos. A chave 'br' em timeline/final/"
    "secoes/t1 é a soma de todas as UFs (incluindo zz). t1 = resultado final do 1º turno por UF "
    "(votacao_partido_munzona, votos nominais válidos; vv = total de votos válidos para Presidente). "
    "Conferência: a curva BR reconstruída bate com o Historico_Totalizacao_Presidente_BR_2T_2022 oficial "
    "do TSE (diferença de poucos milhares de seções no início, quando a totalização atrasava segundos "
    "em relação ao recebimento; virada de Lula a ~67-68% das seções, 18:43-18:44)."
)
NOTES_2018 = (
    "APROXIMAÇÃO: os boletins de urna de 2018 NÃO têm horário de recebimento (sem DT_BU_RECEBIDO/"
    "DT_EMISSAO_BU); só DT_ENCERRAMENTO (relógio local da urna). O horário de chegada de cada seção foi "
    "estimado como DT_ENCERRAMENTO(2018) + atraso observado em 2022 na MESMA seção (UF/município/zona/"
    "seção), onde atraso = DT_BU_RECEBIDO(2022, Brasília) − DT_ENCERRAMENTO(2022, local); o atraso já "
    "embute o fuso local→Brasília. Sem correspondência: mediana da zona, depois do município, depois da "
    "UF. Logo a ORDEM de chegada segue a logística de 2022, não a real de 2018. Diferenças reais: em 2018 "
    "as urnas fecharam às 17:00 de cada fuso (AC/AM etc. depois de Brasília) e a totalização era "
    "regionalizada (TREs); e a divulgação ficou embargada até 19:00 de Brasília, quando já havia boa "
    "parte apurada — o público não viu a parte inicial desta curva. BUs estimados antes das 17:00 "
    "(exterior) foram agrupados às 17:00. Seções não instaladas/não apuradas/anuladas só entram na "
    "última entrada. Seção = seção principal (agregadas não contam à parte). Buckets de 1 min até 99%, "
    "2 min até 99,9%; última entrada contém tudo. validVotes = votos nominais dos 2 candidatos. A chave "
    "'br' é a soma de todas as UFs (incluindo zz). t1 = resultado final do 1º turno por UF "
    "(votacao_partido_munzona). secoes = QT_SECOES_PRINCIPAIS (detalhe_votacao_munzona)."
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, choices=[2022, 2018])
    ap.add_argument("--no-download", action="store_true")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "history"))
    a = ap.parse_args()
    years = [a.year] if a.year else [2022, 2018]
    need = set(years) | ({2022} if 2018 in years else set())
    if not a.no_download:
        for y in sorted(need):
            print(f"checking downloads for {y}...", file=sys.stderr)
            download(y)
    os.makedirs(a.out, exist_ok=True)

    c22 = YEARS[2022]
    secs22 = read_bu(2022, c22["left"]["n"], c22["right"]["n"])
    for y in years:
        cfg = YEARS[y]
        if y == 2022:
            secs = secs22
            notes = NOTES_2022
            src = ("TSE dados abertos: bweb_2t_<UF>_311020221535.zip (Boletim de Urna 2022, 2º turno, "
                   "DT_BU_RECEBIDO); votacao_partido_munzona_2022.zip (_BR.csv, 1º turno); "
                   "detalhe_votacao_munzona_2022.zip (seções)")
        else:
            secs = read_bu(2018, cfg["left"]["n"], cfg["right"]["n"])
            st = estimate_2018_times(secs, secs22)
            print(f"[2018] delay source counts: {st}")
            n = sum(st[k] for k in ("secao", "zona", "mun", "uf"))
            notes = NOTES_2018 + (
                f" Origem do atraso: {st['secao']/n:.1%} mesma seção 2022, {st['zona']/n:.1%} mediana da "
                f"zona, {st['mun']/n:.1%} do município, {st['uf']/n:.1%} da UF.")
            src = ("TSE dados abertos: BWEB_2t_<UF>_301020181744.zip (Boletim de Urna 2018, 2º turno, "
                   "DT_ENCERRAMENTO) + bweb_2t 2022 (DT_BU_RECEBIDO, para estimar atrasos); "
                   "votacao_partido_munzona_2018.zip (_BR.csv, 1º turno); detalhe_votacao_munzona_2018.zip (seções)")
        t1 = read_t1(y, cfg["left"]["n"], cfg["right"]["n"])
        out = build(y, secs, t1, read_secoes(y), notes, src)
        path = os.path.join(a.out, f"{y}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"[{y}] wrote {path} ({os.path.getsize(path)/1e6:.2f} MB)")
        report(y, out, secs)
        if y == 2022:
            crosscheck_2022(out)


if __name__ == "__main__":
    main()
