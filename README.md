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
| `web/` | a interface embutida no app |

O servidor não faz parte deste repositório.

## Conferir o instalador
Os manifestos com o SHA-256 de cada arquivo e do instalador, assinados com a chave do app,
ficam em <https://astrascreenshare.com/codigo.html>.

## Achou um problema de segurança?
Avise pelo site antes de divulgar.
