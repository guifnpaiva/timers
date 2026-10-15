# ⏱ Timers Sequenciais + Buffer

Relógio com **N timers em sequência** e um **buffer geral**. Quando um timer passa do tempo, o excedente é descontado do buffer até você avançar para o próximo. Sessões podem ser **compartilhadas em tempo real**: todos que entram pelo link veem e controlam o mesmo relógio.

## Como usar

1. Abra o site e digite seu nome.
2. **Criar sessão compartilhada** gera um código (ex.: `hecynyf5`). Clique em **🔗 Convidar** para copiar o link.
3. Configure os timers (minutos: `20`, `7,5` ou `12:30`) e o buffer geral.
4. **▶ Play** inicia o Timer 1. Quando ele zerar, o anel fica vermelho e mostra `+MM:SS`, que é o tempo saindo do buffer.
5. **⏭ Próximo** vai para o timer seguinte. No último, ele vira **✔ Finalizar**.

Também dá para **usar sozinho**, sem sincronia. Nesse modo o estado fica salvo no navegador.

| Atalho | Ação |
|---|---|
| `Espaço` | Play / Pausar |
| `N` | Próximo |
| `R` | Reiniciar |
| `P` | Abrir/fechar janela flutuante (PiP) |

### Recursos
- Anel de progresso com cores (verde → âmbar → laranja → vermelho no overtime)
- Barra do buffer geral, linha do tempo proporcional e tabela planejado × real
- Horário previsto de término e horário-limite contando o buffer
- Alertas sonoros e vibração: 1 minuto restante, timer esgotado, buffer esgotado
- Presença: avatares de quem está na sessão; 👑 marca o anfitrião
- Opção **"Somente o anfitrião controla"** para os demais apenas assistirem
- Opção para a sobra de um timer encerrado antes do tempo voltar ao buffer
- **Janela flutuante (Picture-in-Picture)**: botão **PiP** no topo. Abre um mini-relógio sempre visível por cima de outros apps, com Play/Pausar e Próximo
  - Chrome/Edge no computador: janela com botões clicáveis (Document Picture-in-Picture)
  - Safari, iPhone/iPad e Android: janela de vídeo, com os controles de mídia do sistema fazendo Play/Pausar/Próximo
  - Firefox não oferece PiP programável, então o botão não aparece
- Tela não apaga enquanto o relógio corre (Wake Lock, quando suportado)
- Funciona no celular, com a configuração numa gaveta lateral

## Como a sincronia funciona

O GitHub Pages hospeda apenas arquivos estáticos, então a sincronia usa **brokers MQTT públicos e gratuitos** (`broker.emqx.io` e `broker.hivemq.com`) via WebSocket seguro. O app conecta aos dois ao mesmo tempo, por redundância.

- O estado completo da sessão (configuração + andamento) é publicado como mensagem **retida** em `gfnp-timers/v1/<código>/state`. Quem entra recebe a última versão na hora.
- O tempo não é transmitido a cada segundo. O estado guarda quanto cada timer já acumulou e o instante em que o timer atual voltou a correr, e cada navegador calcula o relógio localmente. Por isso todos mostram o mesmo valor.
- Conflitos: vence a alteração mais recente (`rev`).

**Privacidade:** qualquer pessoa que souber o código pode ver e controlar a sessão. Os brokers são públicos e sem garantia de disponibilidade. Não use nomes com informações sensíveis.

## Publicar no GitHub Pages

1. **Settings → Pages** do repositório
2. Em *Build and deployment*, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)` e clique em **Save**
3. Em ~1 minuto o site fica disponível em `https://<usuário>.github.io/<repositório>/`

## Desenvolvimento local

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

Para testar com um broker próprio, passe `?broker=ws://localhost:8888` na URL. Vários brokers podem ser separados por vírgula.

## Estrutura

```
index.html          interface
css/style.css       estilos (tema escuro, responsivo)
js/app.js           modelo, sincronia MQTT e renderização
vendor/mqtt.min.js  MQTT.js 5.16.1 (MIT), incluído localmente
desktop/            versão desktop original em Python/Tkinter
```
