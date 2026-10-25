# Monitor Eleições 2026: Presidente, 2º turno

Painel web da apuração do 2º turno presidencial de 2026 com dados oficiais do TSE, comparado com os 2º turnos de 2022 e 2018.

- **Ao vivo:** votos, % de seções apuradas e chance de vitória de cada candidato.
- **Linha do tempo:** evolução da esquerda e da direita conforme a apuração avança (votos válidos, chance de vitória ou projeção final), com 2026 sobreposto a 2022 e 2018. O eixo pode ser % de seções apuradas ou horário.
- **Regiões:** onde cada candidato cresceu ou caiu em relação ao 1º turno, num mapa de UFs e em tabelas por região e por UF, para 2026, 2022 e 2018.

- **O que cada um precisa para vencer:** média ponderada das pesquisas do 2º turno, com mais peso para as recentes. Mostra quanto o candidato atrás precisa crescer em cada região e o mínimo que o líder precisa manter. Durante a apuração, mostra também que % dos votos que faltam cada um precisa.
- **Exterior por país:** boletins de urna de cada seção, publicados pelo TSE desde o fechamento das urnas no exterior. Compara 1º e 2º turno nas mesmas seções e coloca 2018, 2022 e 2026 lado a lado, com votos ganhos e perdidos por país e cidade.
- **Chat ao vivo:** mensagens em tempo real (SSE), filtro contra palavrões, discurso de ódio, ameaças e links, e uma enquete informal "em quem você votou" (🔴 Lula, 🔵 Flávio, ⚪ Branco/Nulo).
- **Últimas notícias:** manchetes de g1, Folha, Estadão, Poder360, Agência Brasil e Google Notícias, filtradas pela eleição e ordenadas por relevância. Ficam numa coluna à esquerda no desktop e numa seção compacta no celular.
- **Narrador automático:** um robô identificado (🤖, selo "automático") posta no chat os marcos da apuração (comparando com 2022), viradas no país e nos estados grandes, mudanças fortes na chance de vitória, o resultado oficial e notícias de destaque. Ele não vota na enquete. Para desligar: `NARRADOR=off`.
- **Mercados de previsão:** cotações públicas da Kalshi (`KXBRPRES-26`) e da Polymarket (`brazil-presidential-election`), normalizadas para a disputa a dois e comparadas com o modelo do painel ao longo da noite. Onde o provedor bloqueia esses domínios (alguns no Brasil), aparecem como indisponíveis; o painel não contorna bloqueios.
- **Responsivo:** no celular, os candidatos aparecem lado a lado, o gráfico e o mapa respondem ao toque, as tabelas rolam de lado com a primeira coluna fixa, e o chat e as notícias se adaptam.

Não tem dependências: basta ter Node 20 ou mais recente.

```bash
npm start          # coletor + servidor em http://localhost:3000
npm run collect    # só o coletor
npm run serve      # só o servidor (lê o que o coletor gravou)
npm test           # testes do filtro do chat
```

Para publicar (Fly.io recomendado), veja **[DEPLOY.md](DEPLOY.md)**.

## Estrutura

| Arquivo | Papel |
|---|---|
| `server/index.js` | HTTP: arquivos estáticos, rotas, cabeçalhos de segurança, gzip/ETag, cache, limites |
| `server/api.js` | cálculos das rotas (ao vivo, linha do tempo, regiões, exterior, caminho, notícias) |
| `server/collector.js` · `exterior.js` · `noticias.js` · `mercados.js` | coletores: TSE, boletins do exterior, notícias, mercados de previsão |
| `server/narrador.js` | narrador automático do chat |
| `server/chat.js` · `moderacao.js` | chat (SSE), enquete, moderação automática e manual |
| `server/config.js` · `ip.js` · `fsutil.js` | caminhos e variáveis de ambiente, IP real e limites, gravação atômica |
| `shared/model.js` · `caminho.js` | modelo de chance de vitória e cenários das pesquisas |
| `public/` | página: `app.js` (painel), `chat.js`, `noticias.js`, `style.css` |

## Fonte dos dados

| Dado | Origem |
|---|---|
| Apuração 2026 (ao vivo) | `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/<uf>/<uf>-c0001-e006258-u.json` |
| 1º turno 2026 | mesmo caminho, eleição `6257` (em cache em `data/ref/t1-2026.json`) |
| Histórico 2022/2018 | boletins de urna e votação por município/zona do Portal de Dados Abertos do TSE |

O coletor consulta o Brasil e as 28 UFs (incluindo o exterior, `zz`) a cada 30 s. Usa `If-None-Match`, então quando nada mudou o TSE responde 304. Cada mudança é gravada em `data/live/snapshots.jsonl`. O TSE só publica o estado atual, sem histórico: **a linha do tempo de 2026 só tem os pontos coletados enquanto o coletor esteve rodando.**

### Histórico (`data/history/*.json`)

Gerado com `python -I scripts/build_history.py`, que baixa uns 200 MB em `data/raw/`.

- **2022:** cada seção entra na linha do tempo no horário real de recebimento do boletim (`DT_BU_RECEBIDO`). A curva bate com o log oficial de totalização do TSE (virada de Lula com ~67–68% das seções).
- **2018:** os boletins não têm horário de recebimento. O horário é estimado como o encerramento da urna em 2018 somado ao atraso que a mesma seção teve em 2022, então a ordem de chegada segue a logística de 2022. Em 2018 a divulgação ficou embargada até as 19h.

## Modelo de chance de vitória (`shared/model.js`)

Para cada UF, o que falta apurar é projetado misturando a fatia já apurada na UF com o 1º turno da UF (disputa a dois), corrigido pelo desvio nacional observado. Há ainda um ajuste de +1,5 p.p. para a esquerda no que falta apurar: em 2018 e 2022 as seções apuradas por último pendiam à esquerda. A incerteza tem um componente nacional e outro por UF, e os dois encolhem conforme a apuração avança. P(vitória) sai de uma aproximação normal da margem final.

É um modelo heurístico, não uma previsão oficial. O mesmo modelo roda sobre o histórico, então as curvas de 2022 e 2018 mostram como ele teria se comportado naquelas noites:

```bash
node scripts/calibrate.js 0 0.01 0.015 0.02   # erro da projeção por marco, para cada valor de lateDrift
```

## Outros dados

| Arquivo | Conteúdo | Como gerar |
|---|---|---|
| `data/history/exterior.json` | exterior por cidade e país, 2018 e 2022, dois turnos | `python -I scripts/build_exterior.py` |
| `data/polls/2026-t2.json` | pesquisas do 2º turno 2026 (nacional e regiões), com fontes | coletadas manualmente de notícias e da Wikipedia |
| `data/ref/exterior-3220.json`, `data/live/exterior-3221.json` | boletins de urna do exterior, 1º e 2º turno 2026 | o coletor gera |
| `data/chat/` | mensagens e votos do chat | o servidor gera |

## Chat e moderação

O filtro fica em `server/moderacao.js` e é baseado em listas e padrões. Antes de checar, ele normaliza acentos, leetspeak, homóglifos, caracteres invisíveis, letras repetidas e palavras quebradas em pedaços. Ele bloqueia a mensagem inteira em vez de mascarar. Os casos de teste rodam com `npm test`. Nenhum filtro desse tipo é infalível; para o que escapar, existe a moderação manual com `ADMIN_TOKEN` (ver [DEPLOY.md](DEPLOY.md)).

Limites:
- 1 mensagem a cada 30 s por aparelho e 6 a cada 30 s por IP
- até 280 caracteres por mensagem e 20 no apelido
- enquete com um voto por aparelho (pode ser trocado) e até 5 aparelhos por IP

**Atrás de um proxy ou túnel**, defina `CLIENT_IP_HEADER` (`fly-client-ip` no Fly, `x-forwarded-for` no Railway, `cf-connecting-ip` no Cloudflare Tunnel) para que os limites usem o IP real de cada visitante. No Fly e no Railway isso é detectado automaticamente.

## Testar sem esperar o TSE

```bash
node scripts/simulate.js 80 0.6                              # apuração fictícia até 60%, em data/sim/
LIVE_DIR=data/sim PORT=3001 node server/index.js --no-collect
```
