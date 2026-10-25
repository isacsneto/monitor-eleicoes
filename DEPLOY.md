# Deploy (Fly.io ou Railway)

O app é um único processo Node, sem dependências. Ele roda o coletor (TSE, boletins do exterior e notícias), a API e o chat. Por isso há duas exigências:

- **Uma instância só, sempre ligada.** O chat guarda estado em memória e o coletor precisa rodar o tempo todo.
- **Um volume persistente montado em `/data`** para a série ao vivo, os boletins e o chat. Sem ele, cada reinício apaga tudo.

`Dockerfile`, `fly.toml` e `railway.json` já estão prontos.

## Antes de publicar

```bash
npm test          # filtro do chat: 92 casos
npm run seed      # copia a série ao vivo coletada no seu PC para data/seed/ (vai junto no deploy)
git add -A && git commit -m "deploy"
```

O `seed` é o que impede o site publicado de começar a linha do tempo do zero. Na primeira subida, com o volume vazio, o servidor copia `data/seed/` para o volume. Nas subidas seguintes o volume já tem dados e a semente é ignorada.

## Variáveis de ambiente

| Variável | Para quê | Valor |
|---|---|---|
| `ADMIN_TOKEN` | habilita a moderação manual do chat (apagar e banir) | um segredo longo e aleatório (`openssl rand -hex 32`) |
| `CLIENT_IP_HEADER` | de onde ler o IP real do visitante | detectado sozinho: `fly-client-ip` no Fly, `x-forwarded-for` no Railway |
| `DATA_DIR` | onde gravar os dados | `/data` (já definido no Dockerfile) |
| `NODE_ENV` | ativa o HSTS | `production` (já definido) |

Não defina `CLIENT_IP_HEADER` rodando sem proxy: um cabeçalho que o proxy não sobrescreve pode ser forjado pelo visitante.

## Railway

> Em 25/10/2026 o Railway estava com novos cadastros fechados ("Sign ups are currently disabled"). Se você já tem conta, os passos abaixo valem.

1. Envie o repositório para o GitHub e, no Railway, crie um projeto com **Deploy from GitHub repo**. O `railway.json` faz o build pelo Dockerfile.
2. No serviço: **Settings → Volumes → New Volume**, com mount path `/data`.
3. **Variables:** `ADMIN_TOKEN=<segredo>`.
4. **Settings → Networking → Generate Domain** gera o endereço público.
5. Mantenha 1 réplica (o `railway.json` já fixa `numReplicas: 1`).

## Fly.io (recomendado: não precisa de GitHub nem de Docker local)

O `fly deploy` envia a pasta do projeto e o Fly faz o build da imagem nos servidores dele. Troque `NOME` por um nome único, por exemplo `apuracao-2026-seunome`. Ele vira `https://NOME.fly.dev`.

```powershell
fly auth login                                   # abre o navegador (o Fly pede cartão para cobrança)
npm test                                         # 92 casos ok
npm run seed                                     # leva junto a apuração já coletada no seu PC
fly apps create NOME
fly volumes create dados --region gru --size 1 --app NOME --yes
fly secrets set ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") --app NOME
fly deploy --app NOME --ha=false                 # uma única máquina (o chat guarda estado em memória)
fly open --app NOME
```

Para conferir:
- `https://NOME.fly.dev/healthz` deve responder `{"ok":true}`.
- `https://NOME.fly.dev/api/mercados` deve mostrar as cotações da Kalshi e da Polymarket (localmente elas aparecem como indisponíveis porque o seu provedor bloqueia esses domínios).
- `fly logs --app NOME` mostra o coletor trabalhando ao vivo.

Para ver o token de moderação depois: `fly ssh console --app NOME -C "printenv ADMIN_TOKEN"`.

O `fly.toml` já está configurado:
- região São Paulo (`gru`)
- máquina sempre ligada (`auto_stop_machines = "off"`)
- health check em `/healthz`
- volume em `/data`

O custo é de uns US$ 3 a 4 por mês (máquina compartilhada de 512 MB e volume de 1 GB), cobrado por uso. Para desligar depois da eleição: `fly apps destroy NOME`.

## Moderação do chat

Para apagar uma mensagem, use o `id` dela. Ele aparece em `GET /api/chat/stream`, no evento `init`, e no arquivo `/data/chat/mensagens.jsonl`.

```bash
curl -X POST https://SEU-SITE/api/chat/apagar \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<id-da-mensagem>"}'
```

Para apagar e banir o autor (inclusive o IP de onde ele escreveu):

```bash
  -d '{"id":"<id-da-mensagem>","banir":true}'
```

Também dá para usar `{"autor":"<autor>","banir":true}`, que apaga tudo daquele autor.

## Segurança: o que já está coberto

- **Cabeçalhos:** CSP restritiva (só scripts do próprio site), `nosniff`, proteção contra iframe de outros sites, HSTS e `Referrer-Policy`.
- **Arquivos estáticos:** protegidos contra path traversal. URLs malformadas devolvem 400 em vez de derrubar o processo.
- **Limites por IP** (IPv6 agrupado por /64):
  - API: 240 requisições por minuto
  - chat: 1 mensagem a cada 30 s por aparelho e 6 a cada 30 s por IP
  - conexões do chat: 6 por IP e 3.000 no total
  - enquete: até 5 aparelhos por IP
- **POST do chat:** só aceita JSON da própria origem (proteção contra CSRF). Corpo limitado a 4 KB, mensagem a 280 caracteres e apelido a 20.
- **Tempos limite:** cabeçalhos em 10 s e corpo da requisição em 15 s, contra conexões lentas (slowloris).
- **Moderação:** palavrões, discurso de ódio, ameaças e links. Há normalização contra leetspeak, homóglifos, caracteres invisíveis e "zalgo". Para o que escapar, há a moderação manual.
- **Privacidade:** IPs nunca são gravados em claro. Os banimentos guardam só um HMAC.
- **Dados de fora:** os dados do TSE e dos feeds de notícias são lidos com limites de tamanho e de profundidade. Tudo que vai para a página é escapado ou inserido como texto.
