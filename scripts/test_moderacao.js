// Casos de teste do filtro do chat: node scripts/test_moderacao.js (sai com código 1 se algum falhar)
import { moderar, moderarApelido } from '../server/moderacao.js';

const casos = {
  bloquear: [
    'que porra é essa', 'P0RR4', 'poooorrraaa', 'p o r r a', 'vai tomar no cu', 'seu filho da puta', 'nordestino burro não sabe votar',
    'esses baianos preguiçosos', 'volta pra áfrica', 'tem que matar esse cara', 'morte ao comunismo', 'macaco', 'acessa www.site.com',
    'preto imundo', 'gay é doença', 'paraíba ignorante', 'venezuelanos lixo',
    // evasões: zero-width, cirílico, largura total, zalgo, pontuação no meio, RTL override
    'p​orra', 'pоrra', 'ｐｏｒｒａ', 'p̷o̷r̷r̷a̷', 'po.rra', 'pu ta que pariu', 'm e r d a', '‮porra',
    // da auditoria de segurança: pedaços, variações, outros alfabetos, ameaças, links disfarçados
    'po.r.ra', 'pu.t.a', 'mer-d-a', 'porras', 'porrinha', 'karalho', 'phoda', 'kct', 'pօrra', 'ᴘorra', 'porrɑ',
    'Ꮲorra', 'eu mato voce', 'vou matá-lo', 'vou ma.tar ele', 'vou dar um tiro nele', 'nordestino a b c d e burro',
    'exemplo．com', 'exemplo。com', 'exemplo.c​om', 'exemplo . com', 'exemplo[.]com', 'exemplo.shop', 'site.co', 'loja.site',
  ],
  permitir: [
    'Vamos! Lula 13', 'Flávio vai ganhar!!!', 'o nordeste decidiu a eleição', 'sou baiano com orgulho', 'a mata atlântica',
    'o que rola hoje?', 'computador travou', 'Vai Brasil 🇧🇷', 'essa apuração está muito disputada', 'cuidado com fake news',
    'votei branco', 'curitiba já apurou', 'o povo preto votou em peso', 'mulheres decidiram', 'executar o plano',
    'a cor no mapa', 'via do centro', 'São Paulo apurou 80%', 'olha o puma', 'kkkkkkkk',
    'Mato Grosso já apurou 90%', 'moradores do nordeste votaram', 'os nordestinos moram longe', 'no mato', 'tomei um porre',
    'e.g. 50%', 'Lula 13 x Flávio 22', 'ponto de virada', 'São Paulo . Rio', 'a.b.c',
  ],
  apelidosBloqueados: ['admin', 'Moderação TSE', 'Admin TSE', 'TSE Oficial', 'Equipe TSE', 'Narrador', 'O Narrador', 'robô', 'Bot Oficial'],
  apelidosPermitidos: ['Joana', 'Zé do Mato', 'Tsetse'],
};

let erros = 0;
for (const t of casos.bloquear) if (moderar(t).ok) { erros++; console.log('NÃO BLOQUEOU:', JSON.stringify(t)); }
for (const t of casos.permitir) { const r = moderar(t); if (!r.ok) { erros++; console.log('FALSO POSITIVO:', t, '->', r.motivo); } }
for (const a of casos.apelidosBloqueados) if (moderarApelido(a).ok) { erros++; console.log('APELIDO PASSOU:', a); }
for (const a of casos.apelidosPermitidos) if (!moderarApelido(a).ok) { erros++; console.log('APELIDO BLOQUEADO:', a); }
const total = Object.values(casos).reduce((s, l) => s + l.length, 0);
console.log(erros ? `${erros} erro(s)` : `todos os ${total} casos ok`);
process.exitCode = erros ? 1 : 0;
