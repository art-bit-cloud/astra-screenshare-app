# AstraScreenShare — app de PC (código para auditoria)

Código-fonte do aplicativo de PC do [AstraScreenShare](https://astrascreenshare.com) (Tauri 2 + Rust),
publicado para que qualquer pessoa possa conferir o que o programa faz no seu computador.

**Não é código livre.** Leia o [LICENSE](LICENSE): pode ler e auditar, não pode copiar nem reutilizar.

## O que tem aqui
| Pasta | O quê |
|---|---|
| `src-tauri/src/*.rs` | o programa (Rust) |
| `src-tauri/src/ponte.js` | o que a página pode pedir ao programa |
| `src-tauri/capabilities/` | permissões do Tauri |
| `src-tauri/tauri.conf.json` | configuração do app e do instalador |
| `src-tauri/Cargo.toml` / `Cargo.lock` | dependências com versões exatas |
| `src-tauri/instalador.nsh` | passos extras do instalador (NSIS) |
| `src-tauri/icons/` | ícones (necessários para compilar) |
| `src-tauri/som/astra-audio.exe` | auxiliar de som/teclas (**só o binário**; o código dele ainda não está aqui) |
| `package.json` / `package-lock.json` | ferramentas de build (Tauri CLI) com versões exatas |
| `web/` | a interface embutida no app |

O servidor não faz parte deste repositório.

## Versão deste código
**3.0.18** — o mesmo código do instalador `AstraScreenShare-Instalador-3.0.18.exe` distribuído em astrascreenshare.com.

| Arquivo | SHA-256 |
|---|---|
| `AstraScreenShare-Instalador-3.0.18.exe` | `2bc1cfa1f992ea5f4a6694287eed442dfe619bd6a5847f080cfdc9ba946c9dea` |
| `src-tauri/som/astra-audio.exe` | `8c5b761bf052a47539e640f0157069745cbad8098fce6a80496dc9e188c86880` |

O instalador não é byte a byte reproduzível (carimbo de tempo do NSIS e da compilação), mas sai deste código com:

```
npm ci
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

3.0.18: confirmação nativa do Windows antes de começar a capturar (a página não consegue confirmar sozinha).

Correções da 3.0.17 (auditoria de segurança de 16/11/2026): a captura inteira (tela, som, teclas, "não perturbe")
para no programa ao parar, ao recarregar a página e pelo ícone perto do relógio, mesmo com a página travada;
escolha de janela com nome ambíguo é recusada; origem exata da página; atualizador com tempo máximo, só HTTPS e
teto de tamanho; atalho global só com modificador; teclas só com a janela transmitida em foco.

## Conferir o instalador
Os manifestos com o SHA-256 de cada arquivo e do instalador, assinados com a chave do app,
ficam em <https://astrascreenshare.com/codigo.html>.

## Achou um problema de segurança?
Avise pelo site antes de divulgar.
