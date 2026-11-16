// Os processos do astra-audio.exe (o mesmo do programa antigo):
//  - som: PCM 16 bits, 48 kHz, estéreo pelo stdout; "OK"/"ERRO ..." pelo stderr;
//  - silencio: liga o "Não perturbe" do Windows enquanto o stdin estiver aberto;
//  - teclas: "D <código>" / "U <código>" por linha;
//  - desempenho: "GPU <total> <pid>:<uso> ..." por linha.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

const SEM_JANELA: u32 = 0x0800_0000; // CREATE_NO_WINDOW

static SOM: Mutex<Option<Child>> = Mutex::new(None);
static SILENCIO: Mutex<Option<Child>> = Mutex::new(None);
static TECLAS: Mutex<Option<Child>> = Mutex::new(None);
static GPU: Mutex<Option<Child>> = Mutex::new(None);
pub static GPU_DADOS: Mutex<(Option<u32>, Option<HashMap<u32, u32>>)> = Mutex::new((None, None));

pub fn capturador(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("astra-audio.exe"))
        .filter(|p| p.exists())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("astra-audio.exe"))).filter(|p| p.exists()))
}

fn abrir(app: &tauri::AppHandle, args: &[&str], stdin: bool, stdout: bool, stderr: bool) -> Result<Child, String> {
    let exe = capturador(app).ok_or("Capturador de som não encontrado.")?;
    let p = |s: bool| if s { Stdio::piped() } else { Stdio::null() };
    Command::new(exe).args(args).stdin(p(stdin)).stdout(p(stdout)).stderr(p(stderr)).creation_flags(SEM_JANELA).spawn().map_err(|e| e.to_string())
}

fn matar(m: &Mutex<Option<Child>>) {
    if let Some(mut c) = m.lock().unwrap().take() {
        drop(c.stdin.take());
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ---------- som do PC ----------
// Responde quando o capturador disser "OK" (ou o erro dele). `ao_fechar` roda quando ele sai.
pub fn som_iniciar(app: &tauri::AppHandle, args: Vec<String>, canal: Channel<InvokeResponseBody>,
                   ao_fechar: impl FnOnce() + Send + 'static) -> Result<(), String> {
    som_parar();
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let mut filho = abrir(app, &a, false, true, true)?;
    let mut saida = filho.stdout.take().ok_or("sem stdout")?;
    let erros = filho.stderr.take().ok_or("sem stderr")?;
    let id = filho.id();
    *SOM.lock().unwrap() = Some(filho);
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        for linha in BufReader::new(erros).lines() {
            let Ok(t) = linha else { break };
            if t.starts_with("OK") {
                let _ = tx2.send(Ok(()));
            } else if t.starts_with("ERRO") {
                let msg = if t.contains("Windows antigo") {
                    "Seu Windows não permite separar o som (precisa do Windows 10 versão 2004 ou mais novo). Use \"Todo o som do PC\".".to_string()
                } else {
                    format!("Não consegui capturar o som: {}", t.trim_start_matches("ERRO").trim())
                };
                let _ = tx2.send(Err(msg));
            }
        }
    });
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        let mut sobra: Vec<u8> = Vec::new();
        let mut ultimo_envio = std::time::Instant::now();
        loop {
            match saida.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    sobra.extend_from_slice(&buf[..n]);
                    // 3.0.6: junta ~40 ms (7680 bytes) antes de mandar. Cada send do Channel passa pela
                    // thread principal (eval + fetch do IPC); pedacinhos de 10 ms = ~100 idas/s e a janela
                    // ficava "Não está respondendo" durante a live com som.
                    if sobra.len() < 7680 && ultimo_envio.elapsed() < std::time::Duration::from_millis(60) {
                        continue;
                    }
                    let inteiro = sobra.len() - sobra.len() % 4; // quadros inteiros (2 canais x 16 bits)
                    if inteiro > 0 {
                        ultimo_envio = std::time::Instant::now();
                        let pedaco: Vec<u8> = sobra.drain(..inteiro).collect();
                        if canal.send(InvokeResponseBody::Raw(pedaco)).is_err() {
                            break;
                        }
                    }
                }
            }
        }
        let _ = tx.send(Err("O capturador de som fechou.".into()));
        let mut g = SOM.lock().unwrap();
        if g.as_ref().map(|c| c.id()) == Some(id) {
            g.take();
            drop(g);
            ao_fechar();
        }
    });
    match rx.recv_timeout(std::time::Duration::from_secs(8)) {
        Ok(r) => r,
        Err(_) => Err("O capturador de som não respondeu.".into()),
    }
}

pub fn som_parar() {
    matar(&SOM);
}

// ---------- "Não perturbe" durante a live ----------
pub fn silencio(app: &tauri::AppHandle, sim: bool) {
    let mut g = SILENCIO.lock().unwrap();
    if sim && g.is_none() {
        if let Ok(c) = abrir(app, &["silencio"], true, false, false) {
            *g = Some(c);
        }
    } else if !sim {
        if let Some(mut c) = g.take() {
            drop(c.stdin.take()); // fechar o stdin = voltar como estava
            std::thread::spawn(move || {
                let _ = c.wait();
            });
        }
    }
}

pub fn silencio_ligado() -> bool {
    SILENCIO.lock().unwrap().is_some()
}

// ---------- teclas apertadas ----------
fn nome_da_tecla(vk: u32) -> String {
    match vk {
        48..=57 | 65..=90 => char::from_u32(vk).map(|c| c.to_string()).unwrap_or_default(),
        96..=105 => format!("Num{}", vk - 96),
        112..=135 => format!("F{}", vk - 111),
        8 => "⌫".into(), 9 => "Tab".into(), 13 => "Enter".into(), 20 => "Caps".into(), 27 => "Esc".into(),
        32 => "Espaço".into(), 33 => "PgUp".into(), 34 => "PgDn".into(), 35 => "End".into(), 36 => "Home".into(),
        37 => "←".into(), 38 => "↑".into(), 39 => "→".into(), 40 => "↓".into(), 44 => "PrtSc".into(), 45 => "Ins".into(), 46 => "Del".into(),
        16 | 160 | 161 => "Shift".into(), 17 | 162 | 163 => "Ctrl".into(), 18 | 164 | 165 => "Alt".into(),
        91 | 92 => "Win".into(),
        _ => String::new(),
    }
}

// 2.7.32: só teclas de jogo saem do PC (nada do que se digita, como senha ou mensagem).
fn pode_aparecer(n: &str) -> bool {
    const JOGO: [&str; 23] = ["W", "A", "S", "D", "⌫", "Tab", "Enter", "Caps", "Esc", "Espaço", "PgUp", "PgDn", "End", "Home",
        "←", "↑", "→", "↓", "Ins", "Del", "Shift", "Ctrl", "Alt"];
    JOGO.contains(&n) || n.strip_prefix('F').and_then(|x| x.parse::<u32>().ok()).map(|x| (1..=24).contains(&x)).unwrap_or(false)
}

// `focada()` diz se a janela do Astra está na frente (aí nada é mostrado). `mandar` recebe a lista.
pub fn teclas(app: &tauri::AppHandle, sim: bool, focada: impl Fn() -> bool + Send + 'static,
              mandar: impl Fn(Vec<String>) + Send + 'static, ao_fechar: impl FnOnce() + Send + 'static) -> bool {
    if !sim {
        matar(&TECLAS);
        return false;
    }
    let mut g = TECLAS.lock().unwrap();
    if g.is_some() {
        return true;
    }
    let Ok(mut c) = abrir(app, &["teclas"], true, true, false) else { return false };
    let saida = c.stdout.take();
    let id = c.id();
    *g = Some(c);
    drop(g);
    std::thread::spawn(move || {
        const MODS: [&str; 3] = ["Ctrl", "Shift", "Alt"];
        let mut apertadas: Vec<String> = Vec::new();
        let mut ultimo = String::new();
        if let Some(s) = saida {
            for linha in BufReader::new(s).lines() {
                let Ok(l) = linha else { break };
                let mut p = l.trim().split(' ');
                let (tipo, cod) = (p.next().unwrap_or(""), p.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0));
                let nome = nome_da_tecla(cod);
                if nome.is_empty() || !pode_aparecer(&nome) {
                    continue;
                }
                let i = apertadas.iter().position(|x| *x == nome);
                if tipo == "D" && i.is_none() && !focada() {
                    apertadas.push(nome);
                } else if tipo == "U" {
                    if let Some(i) = i {
                        apertadas.remove(i);
                    }
                }
                while apertadas.len() > 6 {
                    apertadas.remove(0);
                }
                let lista: Vec<String> = MODS.iter().filter(|m| apertadas.iter().any(|a| a == *m)).map(|m| m.to_string())
                    .chain(apertadas.iter().filter(|a| !MODS.contains(&a.as_str())).cloned()).collect();
                let chave = lista.join("+");
                if chave != ultimo {
                    ultimo = chave;
                    mandar(lista);
                }
            }
        }
        let mut g = TECLAS.lock().unwrap();
        if g.as_ref().map(|c| c.id()) == Some(id) {
            g.take();
            drop(g);
            ao_fechar();
        }
    });
    true
}

// ---------- placa de vídeo (painel de desempenho) ----------
pub fn medidor_gpu(app: &tauri::AppHandle, sim: bool) {
    if !sim {
        matar(&GPU);
        *GPU_DADOS.lock().unwrap() = (None, None);
        return;
    }
    let mut g = GPU.lock().unwrap();
    if g.is_some() {
        return;
    }
    let Ok(mut c) = abrir(app, &["desempenho"], false, true, false) else { return };
    let saida = c.stdout.take();
    *g = Some(c);
    std::thread::spawn(move || {
        if let Some(s) = saida {
            for linha in BufReader::new(s).lines() {
                let Ok(l) = linha else { break };
                let Some(resto) = l.trim().strip_prefix("GPU ") else { continue };
                let mut p = resto.split(' ');
                let total = p.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
                let mapa: HashMap<u32, u32> = p.filter_map(|x| {
                    let (a, b) = x.split_once(':')?;
                    Some((a.parse().ok()?, b.parse().ok()?))
                }).collect();
                *GPU_DADOS.lock().unwrap() = (Some(total), Some(mapa));
            }
        }
        *GPU_DADOS.lock().unwrap() = (None, None);
    });
}

pub fn parar_tudo() {
    matar(&SOM);
    matar(&TECLAS);
    matar(&GPU);
    let mut g = SILENCIO.lock().unwrap();
    if let Some(mut c) = g.take() {
        drop(c.stdin.take());
        let _ = c.wait();
    }
}
