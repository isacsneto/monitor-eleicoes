#!/usr/bin/env python3
"""
Build data/history/exterior.json: President votes abroad (UF 'ZZ') per city,
1st and 2nd round, for 2018 and 2022, plus a city -> country mapping covering
every exterior city of 2018, 2022 and 2026.

Sources (TSE):
  * data/raw/<year>/votacao_partido_munzona_<year>.zip (file *_BR.csv): votes per
    municipio/zona, both rounds (download handled by build_history.py, or here).
  * 2026 exterior city list: resultados.tse.jus.br config JSON (1st and 2nd round),
    saved to data/raw/2026ext/.
  * Country: curated below by city name (the TSE has no country column; the
    NM_BAIRRO field of eleitorado_local_votacao often holds the country for ZZ
    and is used only as a cross-check when that file is present).

Usage (project root):  python -I scripts/build_exterior.py
"""
import csv
import io
import json
import os
import sys
import unicodedata
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
ODSELE = "https://cdn.tse.jus.br/estatistica/sead/odsele"
CFG26 = {
    "3220": "https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3220/config/zz/zz-p003220-cs.json",
    "3221": "https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/config/zz/zz-p003221-cs.json",
}
YEARS = {
    2022: {"left": {"n": "13", "nome": "LULA"}, "right": {"n": "22", "nome": "JAIR BOLSONARO"},
           "official_zz_t2": (152905, 145264)},
    2018: {"left": {"n": "13", "nome": "FERNANDO HADDAD"}, "right": {"n": "17", "nome": "JAIR BOLSONARO"},
           "official_zz_t2": (53730, 131671)},
}

# country name (pt-BR) -> ISO 3166-1 alpha-2
ISO = {
    "África do Sul": "ZA", "Albânia": "AL", "Alemanha": "DE", "Angola": "AO", "Antígua e Barbuda": "AG",
    "Arábia Saudita": "SA", "Argélia": "DZ", "Argentina": "AR", "Armênia": "AM", "Austrália": "AU",
    "Áustria": "AT", "Azerbaijão": "AZ", "Bahamas": "BS", "Bahrein": "BH", "Bangladesh": "BD",
    "Barbados": "BB", "Bélgica": "BE", "Belize": "BZ", "Benin": "BJ", "Bolívia": "BO",
    "Bósnia e Herzegovina": "BA", "Botsuana": "BW", "Bulgária": "BG", "Burkina Faso": "BF",
    "Cabo Verde": "CV", "Camarões": "CM", "Canadá": "CA", "Catar": "QA", "Cazaquistão": "KZ",
    "Chile": "CL", "China": "CN", "Chipre": "CY", "Colômbia": "CO", "Congo": "CG",
    "Coreia do Norte": "KP", "Coreia do Sul": "KR", "Costa do Marfim": "CI", "Costa Rica": "CR",
    "Croácia": "HR", "Cuba": "CU", "Dinamarca": "DK", "Egito": "EG", "El Salvador": "SV",
    "Emirados Árabes Unidos": "AE", "Equador": "EC", "Eslováquia": "SK", "Eslovênia": "SI",
    "Espanha": "ES", "Estados Unidos": "US", "Estônia": "EE", "Etiópia": "ET", "Filipinas": "PH",
    "Finlândia": "FI", "França": "FR", "Gabão": "GA", "Gana": "GH", "Geórgia": "GE", "Grécia": "GR",
    "Guatemala": "GT", "Guiana": "GY", "Guiana Francesa": "GF", "Guiné": "GN", "Guiné-Bissau": "GW",
    "Guiné Equatorial": "GQ", "Haiti": "HT", "Honduras": "HN", "Hong Kong": "HK", "Hungria": "HU",
    "Índia": "IN", "Indonésia": "ID", "Irã": "IR", "Iraque": "IQ", "Irlanda": "IE", "Israel": "IL",
    "Itália": "IT", "Jamaica": "JM", "Japão": "JP", "Jordânia": "JO", "Kuwait": "KW", "Líbano": "LB",
    "Líbia": "LY", "Malásia": "MY", "Malawi": "MW", "Mali": "ML", "Marrocos": "MA", "México": "MX",
    "Mianmar": "MM", "Moçambique": "MZ", "Namíbia": "NA", "Nepal": "NP", "Nicarágua": "NI",
    "Nigéria": "NG", "Noruega": "NO", "Nova Zelândia": "NZ", "Omã": "OM", "Países Baixos": "NL",
    "Palestina": "PS", "Panamá": "PA", "Paquistão": "PK", "Paraguai": "PY", "Peru": "PE",
    "Polônia": "PL", "Portugal": "PT", "Quênia": "KE", "Reino Unido": "GB",
    "República Dominicana": "DO", "República Democrática do Congo": "CD", "Romênia": "RO",
    "Rússia": "RU", "Santa Lúcia": "LC", "São Tomé e Príncipe": "ST", "Senegal": "SN", "Sérvia": "RS",
    "Singapura": "SG", "Síria": "SY", "Sri Lanka": "LK", "Suécia": "SE", "Suíça": "CH",
    "Suriname": "SR", "Tailândia": "TH", "Taiwan": "TW", "Tanzânia": "TZ", "Tchéquia": "CZ",
    "Timor-Leste": "TL", "Togo": "TG", "Trinidad e Tobago": "TT", "Tunísia": "TN", "Turquia": "TR",
    "Ucrânia": "UA", "Uruguai": "UY", "Vaticano": "VA", "Venezuela": "VE", "Vietnã": "VN",
    "Zâmbia": "ZM", "Zimbábue": "ZW",
}

# TSE exterior city code -> country (curated from the city names; codes stable 2018-2026)
CITY_COUNTRY = {
    "29254": "Costa do Marfim",  # ABIDJÃ
    "29262": "Emirados Árabes Unidos",  # ABU DHABI (inclui seções em Dubai)
    "99198": "Nigéria",  # ABUJA
    "29270": "Gana",  # ACCRA
    "99325": "Etiópia",  # ADIS ABEBA
    "30457": "Países Baixos",  # AMSTERDÃ (ROTTERDÃ em 2018)
    "29289": "Jordânia",  # AMÃ
    "29297": "Turquia",  # ANCARA
    "29300": "Argélia",  # ARGEL
    "29319": "Uruguai",  # ARTIGAS
    "29327": "Paraguai",  # ASSUNÇÃO
    "39241": "Cazaquistão",  # ASTANA
    "29335": "Grécia",  # ATENAS
    "39080": "Estados Unidos",  # ATLANTA
    "99171": "Iraque",  # BAGDÁ
    "39128": "Azerbaijão",  # BAKU
    "99350": "Mali",  # BAMAKO
    "29343": "Tailândia",  # BANGKOK
    "29351": "Espanha",  # BARCELONA
    "99473": "Bahrein",  # BAREIN
    "29360": "Líbano",  # BEIRUTE
    "29378": "Sérvia",  # BELGRADO
    "38881": "Belize",  # BELMOPAN
    "29386": "Alemanha",  # BERLIM
    "29394": "Guiné-Bissau",  # BISSAU
    "29408": "Colômbia",  # BOGOTÁ
    "29416": "Estados Unidos",  # BOSTON
    "39209": "Eslováquia",  # BRATISLAVA
    "39187": "Congo",  # BRAZZAVILLE
    "29424": "Barbados",  # BRIDGETOWN
    "29432": "Bélgica",  # BRUXELAS
    "29440": "Romênia",  # BUCARESTE
    "29459": "Hungria",  # BUDAPESTE
    "29467": "Argentina",  # BUENOS AIRES
    "29475": "Guiana Francesa",  # CAIENA
    "29483": "Egito",  # CAIRO
    "29491": "Austrália",  # CAMBERRA
    "30651": "China",  # CANTÃO
    "29505": "Venezuela",  # CARACAS
    "99384": "Santa Lúcia",  # CASTRIES
    "29513": "Estados Unidos",  # CHICAGO
    "29521": "Uruguai",  # CHUY
    "29530": "África do Sul",  # CIDADE DO CABO
    "29556": "Paraguai",  # CIUDAD DEL ESTE
    "29564": "Venezuela",  # CIUDAD GUAYANA
    "99210": "Bolívia",  # COBIJA
    "29572": "Bolívia",  # COCHABAMBA
    "30929": "Sri Lanka",  # COLOMBO
    "38903": "Guiné",  # CONACRI
    "29580": "Paraguai",  # CONCEPCIÓN
    "29599": "Dinamarca",  # COPENHAGUE
    "38920": "Benin",  # COTONOU
    "29602": "Argentina",  # CÓRDOBA
    "29610": "Senegal",  # DACAR
    "29629": "Bangladesh",  # DACCA
    "29637": "Síria",  # DAMASCO
    "38962": "Tanzânia",  # DAR ES SALAAM
    "29653": "Catar",  # DOHA
    "29661": "Irlanda",  # DUBLIN
    "29645": "Timor-Leste",  # DÍLI
    "99503": "Reino Unido",  # EDIMBURGO
    "29670": "Paraguai",  # ENCARNACIÓN
    "29688": "Suécia",  # ESTOCOLMO
    "30961": "Portugal",  # FARO
    "29696": "Alemanha",  # FRANKFURT
    "30669": "Botsuana",  # GABORONE
    "29700": "Suíça",  # GENEBRA
    "29718": "Guiana",  # GEORGETOWN
    "98000": "Guatemala",  # GUATEMALA
    "29742": "Japão",  # HAMAMATSU
    "29750": "Vietnã",  # HANÓI
    "29769": "Zimbábue",  # HARARE
    "30902": "Estados Unidos",  # HARTFORD
    "29777": "Cuba",  # HAVANA
    "29785": "Finlândia",  # HELSINQUE
    "29793": "Hong Kong",  # HONG KONG
    "29807": "Estados Unidos",  # HOUSTON
    "29815": "Camarões",  # IAUNDÊ
    "38989": "Armênia",  # IEREVAN
    "29823": "Peru",  # IQUITOS
    "29831": "Paquistão",  # ISLAMABADE
    "39306": "Turquia",  # ISTAMBUL
    "29840": "Indonésia",  # JACARTA
    "29173": "Nepal",  # KATMANDU
    "29858": "Ucrânia",  # KIEV
    "99430": "Jamaica",  # KINGSTON-JAMAICA
    "29874": "República Democrática do Congo",  # KINSHASA
    "29882": "Kuwait",  # KUAITE
    "29890": "Malásia",  # KUALA LUMPUR
    "29904": "Bolívia",  # LA PAZ
    "29912": "Nigéria",  # LAGOS
    "29939": "Gabão",  # LIBREVILLE
    "99341": "Malawi",  # LILONGUE
    "29947": "Peru",  # LIMA
    "29955": "Portugal",  # LISBOA
    "39160": "Eslovênia",  # LIUBLIANA
    "29963": "Togo",  # LOMÉ
    "29971": "Reino Unido",  # LONDRES
    "29980": "Estados Unidos",  # LOS ANGELES
    "29998": "Angola",  # LUANDA
    "99287": "Zâmbia",  # LUSACA
    "30066": "Espanha",  # MADRI
    "39263": "Guiné Equatorial",  # MALABO
    "30082": "Filipinas",  # MANILA
    "30074": "Nicarágua",  # MANÁGUA
    "30090": "Moçambique",  # MAPUTO
    "99511": "França",  # MARSELHA
    "39102": "Omã",  # MASCATE
    "39004": "Argentina",  # MENDOZA
    "30104": "México",  # MEXICO
    "30112": "Estados Unidos",  # MIAMI
    "30120": "Itália",  # MILÃO
    "30147": "Uruguai",  # MONTEVIDÉU
    "30155": "Canadá",  # MONTREAL
    "30163": "Rússia",  # MOSCOU
    "30171": "Índia",  # MUMBAI
    "30180": "Alemanha",  # MUNIQUE
    "30198": "Japão",  # NAGÓIA
    "30201": "Quênia",  # NAIRÓBI
    "99180": "Bahamas",  # NASSAU
    "39322": "Chipre",  # NICOSIA
    "30210": "Índia",  # NOVA DELHI
    "30228": "Estados Unidos",  # NOVA YORK
    "99490": "Estados Unidos",  # ORLANDO
    "30244": "Noruega",  # OSLO
    "30252": "Canadá",  # OTTAWA
    "30260": "Panamá",  # PANAMA
    "30279": "Suriname",  # PARAMARIBO
    "30287": "França",  # PARIS
    "30295": "Argentina",  # PASO LOS LIBRES
    "30309": "Paraguai",  # PEDRO JUAN CABALLERO
    "30317": "China",  # PEQUIM
    "30325": "Trinidad e Tobago",  # PORT OF SPAIN
    "30341": "Portugal",  # PORTO
    "30333": "Haiti",  # PORTO PRÍNCIPE
    "30350": "Tchéquia",  # PRAGA
    "30368": "Cabo Verde",  # PRAIA
    "30376": "África do Sul",  # PRETÓRIA
    "99155": "Argentina",  # PUERTO IGUAZÚ
    "99236": "Bolívia",  # PUERTO QUIJARRO
    "99295": "Coreia do Norte",  # PYONGYANG
    "30392": "Equador",  # QUITO
    "30406": "Marrocos",  # RABAT
    "30414": "Palestina",  # RAMALLAH
    "30422": "Arábia Saudita",  # RIADE
    "30430": "Uruguai",  # RIO BRANCO (Río Branco, Cerro Largo)
    "99244": "Uruguai",  # RIVERA
    "30449": "Itália",  # ROMA
    "99147": "Antígua e Barbuda",  # SAINT JOHNS
    "30465": "Paraguai",  # SALTO DEL GUAIRÁ
    "30473": "Bolívia",  # SANTA CRUZ DE LA SIERRA
    "99279": "Venezuela",  # SANTA ELENA DE UAIRÉN
    "30481": "Chile",  # SANTIAGO
    "30988": "Bósnia e Herzegovina",  # SARAJEVO
    "30538": "Coreia do Sul",  # SEUL
    "29548": "Singapura",  # SINGAPURA
    "99333": "Guiana Francesa",  # ST GEORGES DE LOYAPOCK (Saint-Georges-de-l'Oyapock)
    "30562": "Austrália",  # SYDNEY
    "30490": "República Dominicana",  # SÃO DOMINGOS
    "30503": "Estados Unidos",  # SÃO FRANCISCO
    "30511": "Costa Rica",  # SÃO JOSÉ
    "30520": "El Salvador",  # SÃO SALVADOR
    "39225": "São Tomé e Príncipe",  # SÃO TOMÉ
    "30546": "Bulgária",  # SÓFIA
    "30570": "Taiwan",  # TAIPÉ
    "99317": "Estônia",  # TALIN
    "99104": "Geórgia",  # TBILISI
    "30597": "Irã",  # TEERÃ
    "30600": "Honduras",  # TEGUCIGALPA
    "30619": "Israel",  # TEL AVIV
    "99139": "Albânia",  # TIRANA
    "30635": "Canadá",  # TORONTO
    "30686": "Líbia",  # TRÍPOLI
    "30708": "Tunísia",  # TUNIS
    "30627": "Japão",  # TÓQUIO
    "39284": "Burkina Faso",  # UAGADUGU
    "39063": "Canadá",  # VANCOUVER
    "30740": "Polônia",  # VARSÓVIA
    "99252": "Vaticano",  # VATICANO
    "30767": "Áustria",  # VIENA
    "30783": "Estados Unidos",  # WASHINGTON
    "30805": "Nova Zelândia",  # WELLINGTON
    "30821": "Namíbia",  # WINDHOEK
    "30848": "China",  # XANGAI
    "99376": "Mianmar",  # YANGON
    "39020": "Croácia",  # ZAGREB
    "30864": "Suíça",  # ZURIQUE
}


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as r, open(dest + ".part", "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(dest + ".part", dest)


def rows(zp, member):
    with zipfile.ZipFile(zp) as z, z.open(member) as raw:
        r = csv.reader(io.TextIOWrapper(raw, encoding="latin-1", newline=""), delimiter=";")
        h = [c.strip() for c in next(r)]
        ix = {c: i for i, c in enumerate(h)}
        for row in r:
            yield ix, row


def norm(s):
    s = unicodedata.normalize("NFKD", s.upper())
    return "".join(c for c in s if not unicodedata.combining(c)).replace("-", " ").strip()


def main():
    names = {}  # code -> {year: name}
    anos = {}
    for y, cfg in YEARS.items():
        zp = os.path.join(RAW, str(y), f"votacao_partido_munzona_{y}.zip")
        fetch(f"{ODSELE}/votacao_partido_munzona/votacao_partido_munzona_{y}.zip", zp)
        t = {"1": {}, "2": {}}
        for ix, row in rows(zp, f"votacao_partido_munzona_{y}_BR.csv"):
            if row[ix["SG_UF"]].strip() != "ZZ" or row[ix["CD_CARGO"]].strip() != "1":
                continue
            turno = row[ix["NR_TURNO"]].strip()
            cd = "%05d" % int(row[ix["CD_MUNICIPIO"]])
            names.setdefault(cd, {})[y] = row[ix["NM_MUNICIPIO"]].strip()
            v = int(row[ix["QT_VOTOS_NOMINAIS_VALIDOS"]]) + int(row[ix["QT_VOTOS_LEGENDA_VALIDOS"]])
            e = t[turno].setdefault(cd, {"left": 0, "right": 0, "vv": 0})
            p = row[ix["NR_PARTIDO"]].strip()
            if p == cfg["left"]["n"]:
                e["left"] += v
            elif p == cfg["right"]["n"]:
                e["right"] += v
            e["vv"] += v
        anos[str(y)] = {"left": cfg["left"], "right": cfg["right"],
                        "t1": dict(sorted(t["1"].items())), "t2": dict(sorted(t["2"].items()))}
        # checks
        for turno in ("1", "2"):
            tot = {k: sum(e[k] for e in t[turno].values()) for k in ("left", "right", "vv")}
            print(f"[{y}] t{turno} zz: {len(t[turno])} cities, {tot}")
        s2 = (sum(e["left"] for e in t["2"].values()), sum(e["right"] for e in t["2"].values()))
        hist = os.path.join(ROOT, "data", "history", f"{y}.json")
        ref = cfg["official_zz_t2"]
        print(f"[{y}] t2 zz vs BU totals {ref}: {'MATCH' if s2 == ref else 'MISMATCH'}")
        if os.path.exists(hist):
            h = json.load(open(hist, encoding="utf-8"))
            t1zz = {k: sum(e[k] for e in t["1"].values()) for k in ("left", "right", "vv")}
            print(f"[{y}] t1 zz vs history t1.zz {h['t1']['zz']}: {'MATCH' if t1zz == h['t1']['zz'] else 'MISMATCH'}")

    seen26 = set()
    for p, url in CFG26.items():
        dest = os.path.join(RAW, "2026ext", f"zz-{p}.json")
        fetch(url, dest)
        for m in json.load(open(dest, encoding="utf-8"))["abr"][0]["mu"]:
            names.setdefault(m["cd"], {})[2026] = m["nm"]
            seen26.add(m["cd"])
    print(f"[2026] {len(seen26)} cities in config (1T+2T)")

    missing = sorted(c for c in names if c not in CITY_COUNTRY)
    if missing:
        raise SystemExit(f"cities without country mapping: {[(c, names[c]) for c in missing]}")
    bad = sorted({CITY_COUNTRY[c] for c in names} - set(ISO))
    if bad:
        raise SystemExit(f"countries without ISO: {bad}")

    # optional cross-check with NM_BAIRRO (often the country for ZZ) of eleitorado_local_votacao
    for y in (2026, 2022, 2018):
        zp = os.path.join(RAW, "2026ext" if y == 2026 else str(y), f"eleitorado_local_votacao_{y}.zip")
        if not os.path.exists(zp):
            continue
        with zipfile.ZipFile(zp) as z:
            csvs = [i.filename for i in z.infolist() if i.filename.lower().endswith(".csv")]
            member = ([n for n in csvs if n.upper().endswith("_ZZ.CSV")] or csvs)[0]
        bairro = {}
        for ix, row in rows(zp, member):
            if row[ix["SG_UF"]].strip() == "ZZ":
                bairro.setdefault("%05d" % int(row[ix["CD_MUNICIPIO"]]), set()).add(norm(row[ix["NM_BAIRRO"]]))
        known = {norm(k) for k in ISO} | {"INGLATERRA", "CANADA", "COLOMBIA", "BOLIVIA", "VIETNAM",
                                          "COREIA", "REPUBLICA TCHECA", "REPUBLICA ESLOVACA"}
        diffs = []
        for cd, bs in bairro.items():
            for b in bs:
                if b in known and b != norm(CITY_COUNTRY.get(cd, "")):
                    diffs.append((cd, names.get(cd, {}), b, CITY_COUNTRY.get(cd)))
        print(f"[{y}] NM_BAIRRO cross-check: {len(bairro)} cities, differing country-like values: {diffs}")

    cidades = {}
    for cd in sorted(names):
        nm = names[cd].get(2026) or names[cd].get(2022) or names[cd].get(2018)
        pais = CITY_COUNTRY[cd]
        cidades[cd] = {"nome": nm, "pais": pais, "iso": ISO[pais]}
    renamed = {cd: v for cd, v in names.items() if len(set(v.values())) > 1}
    print("names differing across years:", renamed)
    for y in ("2018", "2022"):
        for turno in ("t1", "t2"):
            print(f"[{y}] {turno}: {len(anos[y][turno])} cities, "
                  f"{len({cidades[c]['pais'] for c in anos[y][turno]})} countries")
    print(f"[2026] {len(seen26)} cities, {len({cidades[c]['pais'] for c in seen26})} countries")

    out = {
        "fonte": ("TSE dados abertos: votacao_partido_munzona_2018/2022 (arquivo _BR.csv, SG_UF=ZZ, "
                  "cargo Presidente, 1º e 2º turnos; votos = QT_VOTOS_NOMINAIS_VALIDOS + QT_VOTOS_LEGENDA_VALIDOS "
                  "por NR_PARTIDO); lista de cidades 2026 dos config zz-p003220-cs.json / zz-p003221-cs.json "
                  "(resultados.tse.jus.br); país curado manualmente a partir do nome da cidade."),
        "notas": (
            "Chave = CD_MUNICIPIO do TSE (5 dígitos). Os códigos das cidades do exterior são estáveis entre "
            "2018, 2022 e 2026; só mudam grafias: 30457 era 'ROTTERDÃ' em 2018 e é 'AMSTERDÃ' desde 2022 "
            "(mesmo código, Países Baixos); outras variações só de sufixo/abreviação em 2018 (ex.: "
            "'ACCRA-GANA', 'STA C LA SIERRA-BOLI', 'MÉXICO-MEXI'). 'nome' usa a grafia de 2026 (ou a mais "
            "recente). O TSE não publica coluna de país: o país foi atribuído pelo nome da cidade (cidade-sede "
            "da seção eleitoral; uma jurisdição consular pode ter locais em outras cidades do mesmo país, ex. "
            "Dubai em ABU DHABI) e conferido com o campo NM_BAIRRO do eleitorado_local_votacao 2022, que para "
            "o exterior costuma trazer o país (2018, 2022 e 2026: só divergências de sinônimo, ex. INGLATERRA, COREIA). Guiana Francesa (CAIENA, ST GEORGES DE LOYAPOCK; território "
            "francês, iso GF), Hong Kong (HK), Taiwan (TW), Palestina (RAMALLAH, PS) e Vaticano (VA) ficam "
            "como 'países' próprios. Cidades novas em 2026 sem histórico: DACCA, EDIMBURGO, MARSELHA, ORLANDO, "
            "PYONGYANG, SANTA ELENA DE UAIRÉN; VATICANO só existiu em 2022. Várias cidades (ex. ABUJA, ARGEL, "
            "BAKU, MUMBAI, SARAJEVO) só aparecem a partir de 2022 (em 2018 não houve seção nelas). vv = total "
            "de votos válidos para Presidente na cidade (no 2º turno = left + right). Totais do exterior "
            "conferidos com os boletins de urna (2º turno) e com t1.zz de data/history/<ano>.json."
        ),
        "cidades": cidades,
        "anos": {"2022": anos["2022"], "2018": anos["2018"]},
    }
    path = os.path.join(ROOT, "data", "history", "exterior.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {path} ({os.path.getsize(path)/1e3:.1f} KB)")


if __name__ == "__main__":
    sys.exit(main())
