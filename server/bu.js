// Leitura do boletim de urna (bu.dat) publicado pelo TSE: DER/ASN.1 com o BU dentro de
// um envelope (OCTET STRING). Em vez de implementar o schema inteiro, percorre a árvore
// e coleta as sequências {tipoVoto [1], quantidadeVotos [2], identificacaoVotavel [3]}.
const TIPOS = { 2: 'branco', 3: 'nulo', 4: 'legenda' };

const MAX_DEPTH = 32;

function parse(buf, start, end, out, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  let i = start;
  while (i < end) {
    if (i + 2 > end) return false;
    const tag = buf[i++];
    let len = buf[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4 || i + n > end) return false; // forma indefinida ou tamanho absurdo
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
    }
    const s = i, e = i + len;
    if (e > end) return false;
    if (tag & 0x20) {
      const kids = [];
      parse(buf, s, e, kids, depth + 1);
      out.push({ tag, kids, s, e });
    } else out.push({ tag, s, e });
    i = e;
  }
  return true;
}

const int = (buf, n) => {
  let v = 0;
  for (let k = n.s; k < n.e; k++) v = v * 256 + buf[k];
  return v;
};

function collect(buf, nodes, acc, depth = 0) {
  if (depth > MAX_DEPTH) return;
  for (const n of nodes) {
    if (n.kids) {
      const t = n.kids.find((k) => k.tag === 0x81);
      const q = n.kids.find((k) => k.tag === 0x82);
      const id = n.kids.find((k) => k.tag === 0xa3);
      if (n.tag === 0x30 && t && q) {
        const tipo = int(buf, t);
        const key = tipo === 1 && id?.kids?.[1] ? String(int(buf, id.kids[1])) : TIPOS[tipo] ?? `tipo${tipo}`;
        acc[key] = (acc[key] ?? 0) + int(buf, q);
      } else collect(buf, n.kids, acc, depth + 1);
    } else if (n.tag === 0x04 && n.e - n.s > 2 && buf[n.s] === 0x30) {
      const inner = [];
      if (parse(buf, n.s, n.e, inner)) collect(buf, inner, acc, depth + 1);
    }
  }
}

// Votos por número do candidato ("13", "22", …) e "branco"/"nulo".
// Só serve para boletins com um único cargo — caso das seções do exterior (Presidente).
export function readBu(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const nodes = [];
  parse(buf, 0, buf.length, nodes);
  const acc = {};
  collect(buf, nodes, acc);
  return acc;
}
