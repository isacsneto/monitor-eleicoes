import fs from 'node:fs';

// Escreve num arquivo temporário e renomeia: quem lê nunca vê um JSON pela metade.
// No Windows o rename pode falhar momentaneamente se outro processo estiver lendo; tenta de novo.
export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
