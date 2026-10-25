"""Abstenção por UF e turno (presidente), 2018 e 2022, a partir do
detalhe_votacao_munzona do TSE já baixado por build_history.py.

    python -I scripts/build_abstencao.py   ->  data/history/abstencao.json
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_history import ROOT, csv_rows  # noqa: E402


def ler(year):
    zp = os.path.join(ROOT, "data", "raw", str(year), f"detalhe_votacao_munzona_{year}.zip")
    out = {"t1": {}, "t2": {}}
    for ix, row in csv_rows(zp, lambda n: n.endswith(f"_{year}_BR.csv")):
        if row[ix["CD_CARGO"]].strip() != "1":
            continue
        turno = "t" + row[ix["NR_TURNO"]].strip()
        uf = row[ix["SG_UF"]].strip().lower()
        d = out[turno].setdefault(uf, {"aptos": 0, "comp": 0, "abst": 0})
        d["aptos"] += int(row[ix["QT_APTOS"]])
        d["comp"] += int(row[ix["QT_COMPARECIMENTO"]])
        d["abst"] += int(row[ix["QT_ABSTENCOES"]])
    for t in out.values():
        br = {"aptos": 0, "comp": 0, "abst": 0}
        for d in t.values():
            for k in br:
                br[k] += d[k]
        t["br"] = br
    return {t: dict(sorted(v.items())) for t, v in out.items()}


dados = {
    "source": "TSE dados abertos: detalhe_votacao_munzona_<ano>.zip (_BR.csv, cargo Presidente), QT_APTOS/QT_COMPARECIMENTO/QT_ABSTENCOES",
    "2018": ler(2018),
    "2022": ler(2022),
}
saida = os.path.join(ROOT, "data", "history", "abstencao.json")
with open(saida, "w", encoding="utf-8") as f:
    json.dump(dados, f, ensure_ascii=False, separators=(",", ":"))
for ano in ("2018", "2022"):
    for t in ("t1", "t2"):
        b = dados[ano][t]["br"]
        print(ano, t, b, f"{100 * b['abst'] / b['aptos']:.2f}%")
