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
**3.0.19**: o mesmo código do instalador `AstraScreenShare-Instalador-3.0.19.exe` distribuído em astrascreenshare.com.

| Arquivo | SHA-256 |
|---|---|
| `AstraScreenShare-Instalador-3.0.19.exe` | `c3470c466624d0c8ee7c89bdf3364837bc2ff001744840eb9540f7d9613bf8a5` |
| `AstraScreenShare.exe` (dentro do instalador) | `122d46540b370c3bcb5ed6cade3ae27cfaaa4b495893f9daea994b8851a84261` |
| `astra-audio.exe` (dentro do instalador e em `src-tauri/som/`) | `8c5b761bf052a47539e640f0157069745cbad8098fce6a80496dc9e188c86880` |

O `AstraScreenShare.exe` de dentro do instalador não é igual ao que sai da compilação: o empacotador do Tauri
grava no executável o tipo de pacote (NSIS). Para conferir, abra o instalador com o 7-Zip ou rode
`Get-FileHash "$env:LOCALAPPDATA\AstraScreenShare\AstraScreenShare.exe"` depois de instalar.

O instalador não é byte a byte reproduzível (carimbo de tempo do NSIS e da compilação), mas sai deste código com:

```
npm ci
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

### Histórico
- **3.0.19**: corrige o travamento ao parar a transmissão (trava dupla em `captura_atual`, introduzida na 3.0.17)
  e as telas 1/2 trocadas em PCs com dois monitores (ordem do `EnumDisplayDevices`, a mesma do WebView2).
- **3.0.18**: confirmação nativa do Windows antes de começar a capturar (a página não consegue confirmar sozinha).
- **3.0.17** (auditoria de segurança de 16/11/2026): a captura inteira (tela, som, teclas, "não perturbe")
  para no programa ao parar, ao recarregar a página e pelo ícone perto do relógio, mesmo com a página travada;
  escolha de janela com nome ambíguo é recusada; origem exata da página; atualizador com tempo máximo, só HTTPS e
  teto de tamanho; atalho global só com modificador; teclas só com a janela transmitida em foco.

### Próximo: `astra-audio` com código aberto
O `astra-audio.exe` desta versão ainda é só o binário (o código dele se perdeu). Ele já foi reescrito em Rust,
com o mesmo protocolo, e está em teste; quando for aprovado, o código entra neste repositório junto com a versão.

## Conferir o instalador
Os manifestos com o SHA-256 de cada arquivo e do instalador, assinados com a chave do app,
ficam em <https://astrascreenshare.com/codigo.html>.

## Achou um problema de segurança?
Avise pelo site antes de divulgar.
