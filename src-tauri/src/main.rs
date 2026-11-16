// AstraScreenShare - programa de PC (Tauri).
//
// Fica rodando perto do relógio (bandeja do Windows), fica online para os amigos acharem você,
// volta sozinho para a última sala e avisa quando alguém começa a transmitir. A janela é o mesmo
// site da pasta web/. Substitui o programa em Electron (main.js/preload.js da 2.7.36): as mesmas
// funções, as mesmas regras de segurança e a mesma atualização assinada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod atualizar;
mod electron;
mod fontes;
mod janelas;
mod sistema;
mod som;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Endereços fixos no programa instalado (2.7.33). Só a versão de teste (feature "teste") aceita
// ASTRA_SITE/ASTRA_SERVIDOR, para apontar para o staging.
fn site() -> String {
    #[cfg(feature = "teste")]
    if let Ok(s) = std::env::var("ASTRA_SITE") {
        return s;
    }
    "https://astrascreenshare.com/app/".into()
}
fn servidor() -> String {
    #[cfg(feature = "teste")]
    if let Ok(s) = std::env::var("ASTRA_SERVIDOR") {
        return s;
    }
    "wss://astrascreenshare.com/ws".into()
}
const ORIGEM: &str = "http://tauri.localhost";
const TOQUE_VALE: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct Escolha {
    pub fonte: fontes::Fonte,
    pub som: String,
    pub em: Instant,
}

#[derive(Default)]
pub struct Capturando {
    pub tela: String,
    pub som: bool,
    pub teclas: bool,
}

pub struct Estado {
    eventos: Mutex<Option<Channel<Value>>>,
    capturando: Mutex<Capturando>,
    transmitindo: AtomicBool,
    captura_em: Mutex<Option<Instant>>,
    escolha: Mutex<Option<Escolha>>,
    ultimo_som: Mutex<Option<Escolha>>,
    ultimas_fontes: Mutex<Vec<fontes::Fonte>>,
    ultima_lista: Mutex<Option<Instant>>,
    pub tela_da_live: Mutex<Option<(i32, i32, i32, i32)>>,
    pub protegido: AtomicBool,
    pub visor_aberto: AtomicBool,
    toque_bandeja: Mutex<Option<Instant>>,
    avisou_segundo_plano: AtomicBool,
    saindo: AtomicBool,
    minimizada: AtomicBool,
    maximizada: AtomicBool,
    pub focada: AtomicBool,
    tecla_emergencia: Mutex<String>,
    riscos: Mutex<(Option<Instant>, u32)>,
    vez_desempenho: AtomicU64,
    atualizando: AtomicBool,
    perguntando: AtomicBool,
    sem_mouse: bool,
    aparelho: String,
    pasta: PathBuf,
    pub janelas: janelas::Janelas,
}

static ESTADO: OnceLock<Estado> = OnceLock::new();
pub fn estado(_app: &AppHandle) -> &'static Estado {
    ESTADO.get().expect("estado")
}

fn principal(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("principal")
}

fn hwnd(w: &WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    w.hwnd().ok().map(|h| windows::Win32::Foundation::HWND(h.0 as _))
}

// ---------- 2.7.33: quem pode pedir o quê ----------
// Só a página do próprio programa (web/index.html), na janela principal, pode pedir.
fn eh_principal(w: &WebviewWindow) -> bool {
    w.label() == "principal"
        && w.url().map(|u| u.scheme() == "http" && u.host_str() == Some("tauri.localhost") && (u.path() == "/" || u.path() == "/index.html")).unwrap_or(false)
}

// Clique ou tecla de verdade há pouco, com o Astra na frente (ou um clique no menu do ícone).
fn tocou_agora(app: &AppHandle) -> bool {
    let st = estado(app);
    if teste() && std::env::var("ASTRA_TESTE_TOQUE").is_ok() {
        return true;   // só na versão de teste: o script de teste não tem mouse de verdade
    }
    if st.toque_bandeja.lock().unwrap().map(|t| t.elapsed() < TOQUE_VALE).unwrap_or(false) {
        return true;
    }
    let Some(h) = principal(app).as_ref().and_then(hwnd) else { return false };
    sistema::janela_da_frente_eh(h) && sistema::ms_desde_ultima_entrada() < TOQUE_VALE.as_millis() as u64
}

// Transmissão de verdade = o programa liberou uma captura de tela (não basta a página dizer).
fn captura_recente(app: &AppHandle) -> bool {
    let st = estado(app);
    !st.capturando.lock().unwrap().tela.is_empty()
        && (st.transmitindo.load(SeqCst) || st.captura_em.lock().unwrap().map(|t| t.elapsed() < Duration::from_secs(60)).unwrap_or(false))
}

fn enviar(app: &AppHandle, t: &str, v: Value) {
    if let Some(c) = estado(app).eventos.lock().unwrap().as_ref() {
        let _ = c.send(json!({ "t": t, "v": v }));
    }
}

fn arquivo(app: &AppHandle, nome: &str) -> PathBuf {
    estado(app).pasta.join(nome)
}

// ---------- aviso do próprio programa (a página não consegue esconder) ----------
fn atualizar_indicador(app: &AppHandle) {
    let txt = {
        let c = estado(app).capturando.lock().unwrap();
        let partes: Vec<&str> = [(!c.tela.is_empty(), "tela"), (c.som, "som"), (c.teclas, "teclas")].iter().filter(|x| x.0).map(|x| x.1).collect();
        if partes.is_empty() { String::new() } else { format!("● Capturando: {}", partes.join(", ")) }
    };
    if let Some(w) = principal(app) {
        let _ = w.set_title(&if txt.is_empty() { "AstraScreenShare".to_string() } else { format!("AstraScreenShare ({})", txt) });
    }
    atualizar_bandeja(app, &txt);
}

fn avisar(app: &AppHandle, titulo: &str, texto: &str, sempre: bool) {
    if !sempre && som::silencio_ligado() {
        return;   // ao vivo com as notificações escondidas
    }
    let app = app.clone();
    let (titulo, texto) = (titulo.to_string(), texto.to_string());
    std::thread::spawn(move || {
        let a2 = app.clone();
        let _ = tauri_winrt_notification::Toast::new(&app.config().identifier)
            .title(&titulo)
            .text1(&texto)
            .on_activated(move |_| {
                let a3 = a2.clone();
                let _ = a2.run_on_main_thread(move || mostrar(&a3));
                Ok(())
            })
            .show();
    });
}

// ---------- janela principal ----------
fn ganchos(app: &AppHandle, escondeu: bool) {
    if let Some(w) = principal(app) {
        let js = if escondeu {
            "window.aoEsconder&&aoEsconder();window.aoMinimizar&&aoMinimizar();"
        } else {
            "window.aoMostrar&&aoMostrar();window.aoRestaurar&&aoRestaurar();"
        };
        let _ = w.eval(js);
    }
    if !escondeu {
        janelas::fechar_minis(app);   // 3.0.3: voltou para a janela = nenhuma mini tela sobra (nem preta)
    }
}

fn mostrar(app: &AppHandle) {
    let Some(w) = principal(app) else { return };
    let estava = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    if !estava {
        estado(app).minimizada.store(false, SeqCst);
        ganchos(app, false);
    }
}

fn sair(app: &AppHandle) {
    estado(app).saindo.store(true, SeqCst);
    som::parar_tudo();
    sistema::manter_tela_acordada(false);
    janelas::fechar_todas_capturas(app);
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    app.exit(0);
}

// ---------- bandeja (ícone perto do relógio) ----------
fn atualizar_bandeja(app: &AppHandle, txt: &str) {
    let Some(b) = app.tray_by_id("bandeja") else { return };
    let transmitindo = estado(app).transmitindo.load(SeqCst);
    let dica = if !txt.is_empty() { format!("AstraScreenShare: {}", txt) } else if transmitindo { "AstraScreenShare: transmitindo".into() } else { "AstraScreenShare".into() };
    let _ = b.set_tooltip(Some(&dica));
    let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
        let m = Menu::new(app)?;
        if !txt.is_empty() {
            m.append(&MenuItem::with_id(app, "status", txt, false, None::<&str>)?)?;
            m.append(&PredefinedMenuItem::separator(app)?)?;
        }
        m.append(&MenuItem::with_id(app, "abrir", "Abrir AstraScreenShare", true, None::<&str>)?)?;
        m.append(&MenuItem::with_id(app, "tela", if transmitindo { "Parar transmissão" } else { "Transmitir tela" }, true, None::<&str>)?)?;
        m.append(&PredefinedMenuItem::separator(app)?)?;
        m.append(&CheckMenuItem::with_id(app, "iniciar", "Iniciar com o Windows", true, sistema::iniciar_com_windows(), None::<&str>)?)?;
        m.append(&PredefinedMenuItem::separator(app)?)?;
        m.append(&MenuItem::with_id(app, "sair", "Sair", true, None::<&str>)?)?;
        Ok(m)
    })();
    if let Ok(m) = menu {
        let _ = b.set_menu(Some(m));
    }
}

fn criar_bandeja(app: &AppHandle) -> tauri::Result<()> {
    let icone = app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other("sem ícone")))?;
    TrayIconBuilder::with_id("bandeja")
        .icon(icone)
        .tooltip("AstraScreenShare")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|b, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = e {
                mostrar(b.app_handle());
            }
        })
        .on_menu_event(|app, e| match e.id().as_ref() {
            "abrir" => mostrar(app),
            "tela" => {
                // Clique de verdade no menu do ícone (o Windows que mandou).
                *estado(app).toque_bandeja.lock().unwrap() = Some(Instant::now());
                mostrar(app);
                if let Some(w) = principal(app) {
                    let _ = w.eval("document.getElementById('bt-tela') && document.getElementById('bt-tela').click()");
                }
            }
            "iniciar" => {
                let ligado = !sistema::iniciar_com_windows();
                iniciar_com_windows(app, ligado);
            }
            "sair" => sair(app),
            _ => {}
        })
        .build(app)?;
    atualizar_indicador(app);
    Ok(())
}

// ---------- iniciar com o Windows (pergunta uma vez) ----------
fn iniciar_com_windows(app: &AppHandle, sim: bool) {
    if teste() {
        return;   // testando: não mexe no "Iniciar com o Windows" de verdade
    }
    sistema::definir_iniciar_com_windows(sim);
    let _ = std::fs::write(arquivo(app, "configurado"), "1");
    atualizar_indicador(app);
}

fn perguntou_iniciar(app: &AppHandle) -> bool {
    arquivo(app, "perguntou-iniciar").exists()
}

fn perguntar_iniciar_com_windows(app: &AppHandle) {
    let st = estado(app);
    if teste() || perguntou_iniciar(app) || st.perguntando.swap(true, SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        let dono = principal(&app).as_ref().and_then(hwnd);
        let sim = sistema::perguntar(dono, "AstraScreenShare",
            "Abrir a Astra junto com o Windows?\n\nAssim ela fica perto do relógio e você recebe os convites dos amigos na hora.\n\n\
             Dá para mudar quando quiser: clique com o botão direito no ícone perto do relógio.");
        iniciar_com_windows(&app, sim);
        let _ = std::fs::write(arquivo(&app, "perguntou-iniciar"), if sim { "0" } else { "1" });
        estado(&app).perguntando.store(false, SeqCst);
    });
}

fn teste() -> bool {
    cfg!(feature = "teste") && std::env::var("ASTRA_TESTE").is_ok()
}

// Testando, a página e os arquivos ficam em pastas só do teste: o teste nunca encosta no login de
// verdade (em 2026-11-14 um teste marcou "migrado" na pasta real e o login do Electron não veio).
pub fn perfil_teste(app: &AppHandle) -> Option<PathBuf> {
    if !teste() {
        return None;
    }
    app.path().app_local_data_dir().ok().map(|p| p.join("teste-EBWebView"))
}

// ---------- comandos da página ----------
#[tauri::command]
fn ponte_eventos(app: AppHandle, w: WebviewWindow, canal: Channel<Value>) {
    if !eh_principal(&w) {
        return;
    }
    let max = w.is_maximized().unwrap_or(false);
    *estado(&app).eventos.lock().unwrap() = Some(canal);
    enviar(&app, "max", json!(max));
}

#[tauri::command]
fn aviso(app: AppHandle, w: WebviewWindow, titulo: String, texto: String) {
    if !eh_principal(&w) {
        return;
    }
    // Só avisa no Windows se a janela não estiver na frente.
    if w.is_visible().unwrap_or(false) && estado(&app).focada.load(SeqCst) {
        return;
    }
    avisar(&app, &titulo.chars().take(200).collect::<String>(), &texto.chars().take(500).collect::<String>(), false);
}

#[tauri::command]
fn transmitindo(app: AppHandle, w: WebviewWindow, sim: bool) {
    if !eh_principal(&w) {
        return;
    }
    let st = estado(&app);
    st.transmitindo.store(sim, SeqCst);
    st.protegido.store(sim && st.tela_da_live.lock().unwrap().is_some(), SeqCst);
    janelas::proteger_janelas(&app);
    if !sim {
        ligar_silencio(&app, false);
        janelas::fechar_desenho(&app);
        ligar_teclas(&app, false);
        parar_som(&app);
        st.capturando.lock().unwrap().tela.clear();
        *st.captura_em.lock().unwrap() = None;
        if let Some(r) = st.janelas.captura_atual.lock().unwrap().clone() {
            janelas::fechar_captura(&app, &r);
        }
    }
    atualizar_indicador(&app);
}

#[tauri::command]
fn relaxado(app: AppHandle, w: WebviewWindow, sim: bool) {
    if !eh_principal(&w) {
        return;
    }
    // Assistindo relaxado: a tela não apaga sozinha e a janela ocupa a tela toda.
    let _ = app;
    sistema::manter_tela_acordada(sim);
    let _ = w.set_fullscreen(sim);
}

// Modo Acorde: alguém tocou a campainha. A janela vem para a frente sem roubar o foco e pisca.
#[tauri::command]
fn acorde(app: AppHandle, w: WebviewWindow, nome: String) {
    if !eh_principal(&w) {
        return;
    }
    let estava_na_frente = w.is_visible().unwrap_or(false) && estado(&app).focada.load(SeqCst);
    let _ = w.unminimize();
    if let Some(h) = hwnd(&w) {
        sistema::mostrar_sem_foco(h);
        sistema::piscar(h, true);
    }
    let w2 = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        if !w2.is_fullscreen().unwrap_or(false) {
            let _ = w2.set_always_on_top(false);
        }
        if let Some(h) = hwnd(&w2) {
            sistema::piscar(h, false);
        }
    });
    if !estava_na_frente {
        avisar(&app, "ACORDA! 🔔", &format!("{} quer que você veja uma jogada agora!", nome.chars().take(40).collect::<String>()), false);
    }
}

#[tauri::command]
fn mostrar_janela(app: AppHandle, w: WebviewWindow) {
    if eh_principal(&w) {
        mostrar(&app);
    }
}

// Botões do canto da janela (desenhados pelo Astra) e o F11.
#[tauri::command]
fn janela(app: AppHandle, w: WebviewWindow, acao: String) {
    if !eh_principal(&w) {
        return;
    }
    match acao.as_str() {
        "min" => { let _ = w.minimize(); }
        "max" => { if w.is_maximized().unwrap_or(false) { let _ = w.unmaximize(); } else { let _ = w.maximize(); } }
        "fechar" => fechar_principal(&app, &w),
        "tela-cheia" => { let _ = w.set_fullscreen(!w.is_fullscreen().unwrap_or(false)); }
        _ => {}
    }
}

// Fechar a janela só esconde: o programa continua perto do relógio.
fn fechar_principal(app: &AppHandle, w: &WebviewWindow) {
    let _ = w.hide();
    ganchos(app, true);
    if !estado(app).avisou_segundo_plano.swap(true, SeqCst) {
        avisar(app, "AstraScreenShare continua ligado",
            "Ele fica aqui perto do relógio. Para fechar de vez, clique com o botão direito no ícone e em Sair.", false);
    }
}

// Mensagem que some aberta: o Windows não deixa tirar print nem gravar a janela.
#[tauri::command]
fn proteger_tela(app: AppHandle, w: WebviewWindow, sim: bool) {
    if !eh_principal(&w) {
        return;
    }
    estado(&app).visor_aberto.store(sim, SeqCst);
    janelas::proteger_janelas(&app);
}

// O gravador da NVIDIA (Instant Replay) copia a imagem direto da placa e NÃO respeita a proteção.
#[tauri::command]
fn gravador_nvidia(w: WebviewWindow) -> String {
    if !eh_principal(&w) {
        return String::new();
    }
    const GRAVADORES: [&str; 4] = ["nvidia overlay.exe", "nvidia share.exe", "nvsphelper64.exe", "nvsphelper.exe"];
    let nomes: Vec<String> = sistema::processos().into_iter().map(|p| p.nome.to_lowercase()).collect();
    GRAVADORES.iter().find(|g| nomes.iter().any(|n| n == *g)).map(|g| g.to_string()).unwrap_or_default()
}

#[tauri::command]
async fn popup_chat(app: AppHandle, w: WebviewWindow, m: Value) {
    if !eh_principal(&w) || !m.is_object() {
        return;
    }
    let limpo = json!({
        "nome": m["nome"].as_str().unwrap_or("").chars().take(60).collect::<String>(),
        "texto": m["texto"].as_str().unwrap_or("").chars().take(500).collect::<String>(),
        "cor": m["cor"].as_str().unwrap_or("").chars().take(16).collect::<String>(),
        "foto": m["foto"].as_str().unwrap_or("").chars().take(1000).collect::<String>(),
        "imagem": m["imagem"].as_str().unwrap_or("").chars().take(1000).collect::<String>(),
        "gif": m["gif"].as_bool().unwrap_or(false),
        "tipo": m["tipo"].as_str().unwrap_or("").chars().take(16).collect::<String>(),
    });
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || janelas::mostrar_no_popup(&app2, limpo));
}

// 3.0.3: a página fecha a mini tela de verdade (o close() do JavaScript sozinho deixava a janela preta).
#[tauri::command]
fn fechar_mini(app: AppHandle, w: WebviewWindow) {
    if !eh_principal(&w) {
        return;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || janelas::fechar_minis(&app2));
}

#[tauri::command]
fn popup_vazio(app: AppHandle, w: WebviewWindow) {
    if w.label() == "popup" {
        janelas::popup_vazio(&app);
    }
}

// ---------- escolher a tela ----------
// 2.7.33: a lista (com miniaturas) só sai logo depois de um clique de verdade, no máximo a cada 2 s.
#[tauri::command]
async fn listar_fontes(app: AppHandle, w: WebviewWindow) -> Vec<fontes::Fonte> {
    let st = estado(&app);
    if !eh_principal(&w) || !tocou_agora(&app) {
        return vec![];
    }
    {
        let mut u = st.ultima_lista.lock().unwrap();
        if u.map(|t| t.elapsed() < Duration::from_secs(2)).unwrap_or(false) {
            return vec![];
        }
        *u = Some(Instant::now());
    }
    let lista = tauri::async_runtime::spawn_blocking(fontes::listar).await.unwrap_or_default();
    *st.ultimas_fontes.lock().unwrap() = lista.clone();
    lista
}

#[tauri::command]
fn definir_fonte(app: AppHandle, w: WebviewWindow, id: String, som: String) -> bool {
    let st = estado(&app);
    // 2.7.33: escolher a tela também precisa de um clique de verdade (no botão "Transmitir").
    if !eh_principal(&w) || !tocou_agora(&app) {
        *st.escolha.lock().unwrap() = None;
        return false;
    }
    let fonte = st.ultimas_fontes.lock().unwrap().iter().find(|f| f.id == id).cloned();
    // Transmitindo um monitor inteiro: os desenhos dos amigos aparecem por cima dele.
    *st.tela_da_live.lock().unwrap() = fonte.as_ref().and_then(|f| f.retangulo);
    let ok = fonte.is_some();
    *st.escolha.lock().unwrap() = fonte.map(|fonte| Escolha { fonte, som: som.chars().take(20).collect(), em: Instant::now() });
    st.ultimas_fontes.lock().unwrap().clear();   // solta as miniaturas da memória
    ok
}

// O getDisplayMedia da página (ponte.js) chega aqui: abre a janela de captura da fonte escolhida.
#[tauri::command]
async fn captura_iniciar(app: AppHandle, w: WebviewWindow, largura: u32, altura: u32, qps: u32) -> Result<Value, String> {
    if !eh_principal(&w) {
        return Err("Só a página do programa pode transmitir.".into());
    }
    let st = estado(&app);
    // 2.7.33: só logo depois de escolher a tela (30 s), e a escolha vale uma vez.
    let escolha = st.escolha.lock().unwrap().take().filter(|e| e.em.elapsed() < Duration::from_secs(30))
        .ok_or("Escolha a tela na janela \"Transmitir tela\".")?;
    let (selecao, sem_mouse) = (escolha.fonte.selecao.clone(), st.sem_mouse);
    let app2 = app.clone();
    let rotulo = tauri::async_runtime::spawn_blocking(move || janelas::abrir_captura(&app2, &selecao, sem_mouse, largura, altura, qps))
        .await.map_err(|e| e.to_string())??;
    *st.captura_em.lock().unwrap() = Some(Instant::now());
    st.capturando.lock().unwrap().tela = escolha.fonte.nome.clone();
    *st.ultimo_som.lock().unwrap() = Some(escolha.clone());
    atualizar_indicador(&app);
    avisar(&app, "A Astra começou a transmitir",
        &format!("Capturando: {}. Para parar, use \"Parar\" no Astra ou o menu do ícone perto do relógio.", escolha.fonte.nome), true);
    Ok(json!({ "rotulo": rotulo, "superficie": if escolha.fonte.tela { "monitor" } else { "window" }, "nome": escolha.fonte.nome }))
}

#[tauri::command]
fn captura_parar(app: AppHandle, w: WebviewWindow, rotulo: String) {
    if eh_principal(&w) {
        janelas::fechar_captura(&app, &rotulo);
    }
}

#[tauri::command]
fn sinal_principal(app: AppHandle, w: WebviewWindow, msg: String) {
    if eh_principal(&w) && msg.len() < 200_000 {
        janelas::sinal_para_captura(&app, &msg);
    }
}

#[tauri::command]
fn sinal_captura(app: AppHandle, w: WebviewWindow, msg: String) {
    let atual = estado(&app).janelas.captura_atual.lock().unwrap().clone();
    if atual.as_deref() == Some(w.label()) && msg.len() < 200_000 {
        enviar(&app, "sinal", json!({ "de": w.label(), "msg": msg }));
    }
}

// ---------- som sem o Discord e sem o próprio programa (astra-audio.exe) ----------
fn parar_som(app: &AppHandle) {
    som::som_parar();
    let mudou = std::mem::replace(&mut estado(app).capturando.lock().unwrap().som, false);
    if mudou {
        atualizar_indicador(app);
    }
}

#[tauri::command]
async fn som_iniciar(app: AppHandle, w: WebviewWindow, canal: Channel<InvokeResponseBody>) -> Value {
    parar_som(&app);
    // 2.7.33: o som do PC só é capturado junto com uma transmissão que a pessoa começou.
    if !eh_principal(&w) || !captura_recente(&app) {
        return json!({ "ok": false, "erro": "O som só é capturado durante uma transmissão." });
    }
    let pid = std::process::id().to_string();
    let args: Vec<String> = match estado(&app).ultimo_som.lock().unwrap().as_ref() {
        Some(e) if e.som == "janela" && !e.fonte.tela => vec!["incluir-janela".into(), e.fonte.id.trim_start_matches("janela:").to_string()],
        // Todo o som do PC menos o do próprio Astra (música da sala e telas dos amigos), senão faz eco.
        Some(e) if e.som == "tudo" => vec!["excluir-pid".into(), pid],
        // Sem o Discord e sem o próprio Astra.
        _ => vec!["mixar".into(), pid, "Discord.exe".into(), "DiscordPTB.exe".into(), "DiscordCanary.exe".into()],
    };
    estado(&app).capturando.lock().unwrap().som = true;
    atualizar_indicador(&app);
    let app2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let app3 = app2.clone();
        som::som_iniciar(&app2, args, canal, move || {
            estado(&app3).capturando.lock().unwrap().som = false;
            atualizar_indicador(&app3);
        })
    }).await.unwrap_or_else(|e| Err(e.to_string()));
    match r {
        Ok(()) => json!({ "ok": true }),
        Err(e) => {
            parar_som(&app);
            json!({ "ok": false, "erro": e })
        }
    }
}

#[tauri::command]
fn som_parar(app: AppHandle, w: WebviewWindow) {
    if eh_principal(&w) {
        parar_som(&app);
    }
}

// ---------- esconder as notificações durante a live ----------
fn ligar_silencio(app: &AppHandle, sim: bool) {
    som::silencio(app, sim);
    janelas::proteger_janelas(app);
}

#[tauri::command]
fn silencio(app: AppHandle, w: WebviewWindow, sim: bool) {
    if eh_principal(&w) {
        ligar_silencio(&app, sim);
    }
}

// ---------- teclas apertadas (opção da live) ----------
fn ligar_teclas(app: &AppHandle, sim: bool) {
    let st = estado(app);
    if !sim {
        som::teclas(app, false, || false, |_| {}, || {});
        if std::mem::replace(&mut st.capturando.lock().unwrap().teclas, false) {
            atualizar_indicador(app);
        }
        return;
    }
    // 2.7.33: só durante uma transmissão que a pessoa começou.
    if !captura_recente(app) {
        return;
    }
    let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
    let ok = som::teclas(app, true,
        move || estado(&a1).focada.load(SeqCst),
        move |lista| enviar(&a2, "teclas", json!(lista)),
        move || {
            estado(&a3).capturando.lock().unwrap().teclas = false;
            atualizar_indicador(&a3);
        });
    if ok {
        st.capturando.lock().unwrap().teclas = true;
        atualizar_indicador(app);
    }
}

#[tauri::command]
fn teclas(app: AppHandle, w: WebviewWindow, sim: bool) {
    if eh_principal(&w) {
        ligar_teclas(&app, sim);
    }
}

// ---------- desenhos dos amigos ----------
// 2.7.33: o risco é conferido aqui: até 64 pontos de 0 a 1, 60 por segundo, cor #rrggbb ou "borracha".
fn risco_limpo(r: &Value) -> Option<Value> {
    let pts = r.get("pts")?.as_array()?;
    if pts.is_empty() || pts.len() > 64 {
        return None;
    }
    let cor = r.get("cor")?.as_str()?;
    let cor_ok = cor == "borracha" || (cor.len() == 7 && cor.starts_with('#') && cor[1..].chars().all(|c| c.is_ascii_hexdigit()));
    if !cor_ok {
        return None;
    }
    let mut limpos = Vec::with_capacity(pts.len());
    for p in pts {
        let p = p.as_array()?;
        let (x, y) = (p.first()?.as_f64()?, p.get(1)?.as_f64()?);
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        limpos.push(json!([x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)]));
    }
    let id = match r.get("id") {
        Some(Value::String(s)) => s.chars().take(40).collect::<String>(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    Some(json!({ "id": id, "cor": cor, "pts": limpos }))
}

#[tauri::command]
async fn risco(app: AppHandle, w: WebviewWindow, r: Value) {
    let st = estado(&app);
    janelas::diario(&format!("risco: principal={} transmitindo={} tela={:?}", eh_principal(&w), st.transmitindo.load(SeqCst), st.tela_da_live.lock().unwrap()));
    if !eh_principal(&w) || !st.transmitindo.load(SeqCst) || st.tela_da_live.lock().unwrap().is_none() {
        return;
    }
    {
        let mut g = st.riscos.lock().unwrap();
        if g.0.map(|t| t.elapsed() > Duration::from_secs(1)).unwrap_or(true) {
            *g = (Some(Instant::now()), 0);
        }
        g.1 += 1;
        if g.1 > 60 {
            return;
        }
    }
    let Some(r) = risco_limpo(&r) else { return };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || janelas::desenhar(&app2, r));
}

// Tecla de emergência: funciona até com o jogo na frente. Apaga os rabiscos e avisa a janela.
#[tauri::command]
fn tecla_emergencia(app: AppHandle, w: WebviewWindow, acel: String) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    if !eh_principal(&w) {
        return false;
    }
    let st = estado(&app);
    let mut atual = st.tecla_emergencia.lock().unwrap();
    if !atual.is_empty() {
        let _ = app.global_shortcut().unregister(atual.as_str());
    }
    atual.clear();
    if acel.is_empty() {
        return true;
    }
    let ok = app.global_shortcut().on_shortcut(acel.as_str(), |app, _, e| {
        if e.state == ShortcutState::Pressed {
            janelas::fechar_desenho(app);
            enviar(app, "emergencia", Value::Null);
        }
    }).is_ok();
    if ok {
        *atual = acel;
    }
    ok
}

// ---------- painel de desempenho ----------
#[tauri::command]
fn desempenho(app: AppHandle, w: WebviewWindow, ligado: bool) {
    if !eh_principal(&w) {
        return;
    }
    let vez = estado(&app).vez_desempenho.fetch_add(1, SeqCst) + 1;
    som::medidor_gpu(&app, ligado);
    if !ligado {
        return;
    }
    std::thread::spawn(move || {
        let medir = || {
            let pids = sistema::arvore();
            let (cpu, ram, cpu_pc, ram_usada, ram_total) = sistema::medir(&pids);
            let (gpu_total, gpu_pids) = som::GPU_DADOS.lock().unwrap().clone();
            let gpu_app = gpu_pids.map(|m| pids.iter().map(|p| m.get(p).copied().unwrap_or(0)).sum::<u32>().min(100));
            json!({
                "app": { "cpu": cpu, "ram": ram, "gpu": if gpu_total.is_some() { json!(gpu_app) } else { Value::Null }, "ramGpu": 0 },
                "pc": { "cpu": cpu_pc, "ramUsada": ram_usada, "ramTotal": ram_total, "gpu": gpu_total },
            })
        };
        medir();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if estado(&app).vez_desempenho.load(SeqCst) != vez {
                break;
            }
            enviar(&app, "desempenho", medir());
        }
    });
}

// ---------- minigames assinados e atualização ----------
#[tauri::command]
fn conferir_modulo(w: WebviewWindow, nome: String, texto: String, assinatura: String) -> bool {
    eh_principal(&w) && atualizar::conferir_modulo(&nome, &texto, &assinatura)
}

#[tauri::command]
async fn atualizar(app: AppHandle, w: WebviewWindow) -> Value {
    let st = estado(&app);
    if !eh_principal(&w) || st.atualizando.swap(true, SeqCst) {
        return json!({ "ok": false });
    }
    let versao = app.package_info().version.to_string();
    let app2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        atualizar::baixar_e_conferir(&site(), &versao, |p| enviar(&app2, "atualizar", json!(p)))
    }).await.unwrap_or_else(|e| Err(e.to_string()));
    match r {
        Ok(instalador) => {
            enviar(&app, "atualizar", json!("instalando"));
            let aberto = std::process::Command::new(&instalador).args(["/S", "--force-run"]).spawn();
            match aberto {
                Ok(_) => {
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(800));
                        let a3 = app2.clone();
                        let _ = app2.run_on_main_thread(move || sair(&a3));
                    });
                    json!({ "ok": true })
                }
                Err(e) => {
                    st.atualizando.store(false, SeqCst);
                    json!({ "ok": false, "erro": e.to_string() })
                }
            }
        }
        Err(e) => {
            st.atualizando.store(false, SeqCst);
            json!({ "ok": false, "assinatura": e.contains("assinatura"), "erro": e })
        }
    }
}

#[tauri::command]
fn sem_mouse_salvar(app: AppHandle, w: WebviewWindow, sim: bool) {
    if !eh_principal(&w) {
        return;
    }
    let f = arquivo(&app, "mostrar-mouse");
    if sim { let _ = std::fs::remove_file(f); } else { let _ = std::fs::write(f, "1"); }
}

#[tauri::command]
fn reiniciar(app: AppHandle, w: WebviewWindow) {
    if eh_principal(&w) {
        som::parar_tudo();
        app.restart();
    }
}

// ---------- dados do programa antigo (Electron) ----------
// A 2.7.36 guardou uma cópia do localStorage em %APPDATA%\AstraScreenShare\migracao-dados.json.
// Na primeira vez, ela vai para a página (sem apagar nada que já exista nela): ninguém é deslogado.
fn pasta_antiga() -> Option<PathBuf> {
    if teste() {
        return std::env::var_os("ASTRA_PASTA_ANTIGA").map(PathBuf::from);   // testando: nunca o login de verdade
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("AstraScreenShare"))
}

// Duas marcas na página:
//  - __astra_migrado: as configurações já vieram (só preenche o que estiver vazio);
//  - __astra_login_migrado: o LOGIN já veio. Na primeira vez a conta do programa antigo (ID + chave +
//    nomes + foto) SEMPRE ganha da que estiver na página: quem já entrava no PC continua na mesma conta,
//    mesmo que algo tenha criado uma conta nova antes (como o teste de 2026-11-14). Depois disso a
//    pessoa troca/sai de conta à vontade e nada é trazido de novo.
const CHAVES_DO_LOGIN: [&str; 7] = ["astra.id", "astra.chave", "astra.nome", "astra.exibicao", "astra.foto", "astra.capa", "astra.perfil"];

// Junta as duas fontes: a cópia migracao-dados.json (2.7.36+) e, por cima, o banco do próprio
// Electron (sempre o mais atual, e o único que existe para quem vem de antes da 2.7.36).
pub fn dados_antigos() -> Option<serde_json::Map<String, Value>> {
    let antiga = pasta_antiga()?;
    let mut dados = std::fs::read_to_string(antiga.join("migracao-dados.json")).ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("localStorage").and_then(|l| l.as_object()).cloned())
        .unwrap_or_default();
    if let Some(banco) = electron::ler_local_storage(&antiga) {
        dados.extend(banco);
    }
    if dados.is_empty() { None } else { Some(dados) }
}

fn script_migracao(_app: &AppHandle) -> Option<String> {
    let dados = dados_antigos()?;
    let limpo: serde_json::Map<String, Value> = dados.iter()
        .filter(|(k, _)| !k.starts_with("__astra_"))
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), json!(s)))).collect();
    let tem_login = limpo.get("astra.id").and_then(|x| x.as_str()).map(|s| s.len() == 9 && s.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false)
        && limpo.get("astra.chave").and_then(|x| x.as_str()).map(|s| (20..=100).contains(&s.len())).unwrap_or(false);
    Some(format!(
        "(function(){{try{{if(location.origin!=={o}||window.top!==window)return;var L=localStorage,d={d};\
         if(!L.getItem('__astra_migrado')){{for(var k in d)if(L.getItem(k)===null)L.setItem(k,d[k]);L.setItem('__astra_migrado','1');}}\
         if(!L.getItem('__astra_login_migrado')){{if({tem}){{var c={c};for(var i=0;i<c.length;i++){{if(c[i] in d)L.setItem(c[i],d[c[i]]);else L.removeItem(c[i]);}}}}\
         L.setItem('__astra_login_migrado','1');}}}}catch(e){{}}}})();",
        o = json!(ORIGEM), d = Value::Object(limpo), tem = tem_login, c = json!(CHAVES_DO_LOGIN)))
}

// Escolhas guardadas pelo programa antigo que continuam valendo.
fn trazer_escolhas_antigas(app: &AppHandle) {
    let Some(antiga) = pasta_antiga() else { return };
    for nome in ["perguntou-iniciar", "mostrar-mouse", "configurado"] {
        let (de, para) = (antiga.join(nome), arquivo(app, nome));
        if de.exists() && !para.exists() && !arquivo(app, "migrado").exists() {
            let _ = std::fs::copy(de, para);
        }
    }
}

// ---------- abrir ----------
// Argumentos do WebView2 da janela principal. O pop-up e os desenhos usam o mesmo perfil, e o
// WebView2 só aceita outra janela no mesmo perfil se os argumentos forem iguais.
pub fn args_principal() -> String {
    static ARGS: OnceLock<String> = OnceLock::new();
    ARGS.get_or_init(|| {
        let mut a = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,WebRtcHideLocalIpsWithMdns,SpareRendererForSitePerProcess,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication --autoplay-policy=no-user-gesture-required");
        if teste() {
            if let Ok(p) = std::env::var("ASTRA_CDP") {
                a += &format!(" --remote-debugging-port={}", p.parse::<u16>().unwrap_or(9334));
            }
        }
        a
    }).clone()
}

fn criar_principal(app: &AppHandle, oculto: bool) -> tauri::Result<()> {
    let st = estado(app);
    let inicio = json!({
        "origem": ORIGEM, "servidor": servidor(), "site": site(), "versao": app.package_info().version.to_string(),
        "aparelho": st.aparelho, "semMouse": st.sem_mouse,
    });
    let ponte = format!("window.__ASTRA_INICIO__={};\n{}", inicio, include_str!("ponte.js"));
    let app_nova = app.clone();
    let app_carga = app.clone();
    let args = args_principal();
    let mut b = WebviewWindowBuilder::new(app, "principal", WebviewUrl::App("index.html".into()))
        .title("AstraScreenShare")
        .inner_size(1280.0, 780.0)
        .min_inner_size(400.0, 520.0)
        .visible(!oculto)
        .decorations(false)   // a janela é toda do Astra; min/max/fechar são botões do app.js
        .shadow(true)
        .background_color(tauri::window::Color(0x1e, 0x1f, 0x22, 255))
        .additional_browser_args(&args)
        .initialization_script(ponte)
        // 2.7.33: a janela só mostra a página do programa.
        .on_navigation(|u| u.scheme() == "http" && u.host_str() == Some("tauri.localhost") && (u.path() == "/" || u.path() == "/index.html"))
        .on_new_window(move |url, recursos| janelas::nova_janela(&app_nova, url, recursos))
        // Câmera e microfone (voz e câmera da sala) só para a página do programa; o resto é "não".
        .on_permission_request(|w, tipo| {
            let da_pagina = w.url().map(|u| u.host_str() == Some("tauri.localhost")).unwrap_or(false);
            match tipo {
                PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Autoplay if da_pagina => PermissionResponse::Allow,
                _ => PermissionResponse::Deny,
            }
        })
        .on_page_load(move |_, p| {
            let app = &app_carga;
            match p.event() {
                // A página recarregou: as capturas abertas por ela não servem mais.
                PageLoadEvent::Started => janelas::fechar_todas_capturas(app),
                PageLoadEvent::Finished => {
                    if let Some(w) = principal(app) {
                        janelas::avisar_falha(&w);
                    }
                    if !arquivo(app, "migrado").exists() {
                        let _ = std::fs::write(arquivo(app, "migrado"), "1");
                    }
                    if !perguntou_iniciar(app) && principal(app).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false) {
                        perguntar_iniciar_com_windows(app);
                    }
                }
            }
        });
    if let Some(m) = script_migracao(app) {
        b = b.initialization_script(m);
    }
    if let Some(p) = perfil_teste(app) {
        b = b.data_directory(p);
    }
    let w = b.build()?;
    janelas::vigiar_processo(app, &w);
    let app2 = app.clone();
    w.on_window_event(move |e| {
        let st = estado(&app2);
        match e {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !st.saindo.load(SeqCst) {
                    api.prevent_close();
                    if let Some(w) = principal(&app2) {
                        fechar_principal(&app2, &w);
                    }
                }
            }
            tauri::WindowEvent::Focused(f) => st.focada.store(*f, SeqCst),
            tauri::WindowEvent::Resized(_) => {
                let Some(w) = principal(&app2) else { return };
                // Minimizou assistindo alguém: o app.js abre a mini tela.
                let min = w.is_minimized().unwrap_or(false);
                if st.minimizada.swap(min, SeqCst) != min {
                    ganchos(&app2, min);
                    if !min && !perguntou_iniciar(&app2) {
                        perguntar_iniciar_com_windows(&app2);
                    }
                }
                let max = w.is_maximized().unwrap_or(false);
                if st.maximizada.swap(max, SeqCst) != max {
                    enviar(&app2, "max", json!(max));
                }
            }
            _ => {}
        }
    });
    Ok(())
}

fn main() {
    // 2.7.36: com depurador remoto (outro programa controlando a janela e lendo o login) não abre.
    if sistema::com_depurador() {
        std::process::exit(0);
    }
    sistema::limpar_variaveis_webview2();
    // Só na versão de teste: confere a leitura do programa antigo e sai (não mostra a chave).
    if teste() && std::env::var("ASTRA_LER_ELECTRON").is_ok() {
        let banco = pasta_antiga().and_then(|p| electron::ler_local_storage(&p));
        let junto = dados_antigos();
        let s = |m: &Option<serde_json::Map<String, Value>>, k: &str| m.as_ref().and_then(|m| m.get(k)).and_then(|v| v.as_str()).map(|s| s.to_string());
        janelas::diario(&format!(
            "ler-electron: banco={} itens id={:?} nome={:?} exibicao={:?} chave_len={} | junto={} itens chave_igual={}",
            banco.as_ref().map(|b| b.len()).unwrap_or(0), s(&banco, "astra.id"), s(&banco, "astra.nome"), s(&banco, "astra.exibicao"),
            s(&banco, "astra.chave").map(|c| c.len()).unwrap_or(0), junto.as_ref().map(|b| b.len()).unwrap_or(0),
            s(&banco, "astra.chave") == s(&junto, "astra.chave")));
        std::process::exit(0);
    }
    let oculto = std::env::args().any(|a| a == "--oculto");

    tauri::Builder::default()
        // Só uma cópia do programa aberta; abrir de novo só mostra a janela.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| mostrar(app)))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ponte_eventos, aviso, transmitindo, relaxado, acorde, mostrar_janela, janela, proteger_tela, gravador_nvidia,
            popup_chat, popup_vazio, fechar_mini, listar_fontes, definir_fonte, captura_iniciar, captura_parar, sinal_principal, sinal_captura,
            som_iniciar, som_parar, silencio, teclas, risco, tecla_emergencia, desempenho, conferir_modulo, atualizar,
            sem_mouse_salvar, reiniciar
        ])
        .setup(move |app| {
            let mut pasta = app.path().app_data_dir()?;
            if teste() {
                pasta = pasta.join("teste");
            }
            std::fs::create_dir_all(&pasta)?;
            let h = app.handle().clone();
            // "Esconder o mouse em jogos" (2.7.11), ligado por padrão; vale ao abrir o programa.
            let sem_mouse = !pasta.join("mostrar-mouse").exists()
                && !pasta_antiga().map(|a| a.join("mostrar-mouse").exists() && !pasta.join("migrado").exists()).unwrap_or(false);
            let _ = ESTADO.set(Estado {
                eventos: Mutex::new(None),
                capturando: Mutex::new(Capturando::default()),
                transmitindo: AtomicBool::new(false),
                captura_em: Mutex::new(None),
                escolha: Mutex::new(None),
                ultimo_som: Mutex::new(None),
                ultimas_fontes: Mutex::new(vec![]),
                ultima_lista: Mutex::new(None),
                tela_da_live: Mutex::new(None),
                protegido: AtomicBool::new(false),
                visor_aberto: AtomicBool::new(false),
                toque_bandeja: Mutex::new(None),
                avisou_segundo_plano: AtomicBool::new(false),
                saindo: AtomicBool::new(false),
                minimizada: AtomicBool::new(false),
                maximizada: AtomicBool::new(false),
                focada: AtomicBool::new(false),
                tecla_emergencia: Mutex::new(String::new()),
                riscos: Mutex::new((None, 0)),
                vez_desempenho: AtomicU64::new(0),
                atualizando: AtomicBool::new(false),
                perguntando: AtomicBool::new(false),
                sem_mouse,
                aparelho: sistema::aparelho(),
                pasta,
                janelas: janelas::Janelas::default(),
            });
            trazer_escolhas_antigas(&h);
            if !teste() {
                sistema::migrar_iniciar_com_windows();
            }
            criar_principal(&h, oculto)?;
            criar_bandeja(&h)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao abrir o AstraScreenShare")
        .run(|app, e| match e {
            // Não fecha quando as janelas fecham: continua na bandeja.
            tauri::RunEvent::ExitRequested { api, code: None, .. } if !estado(app).saindo.load(SeqCst) => api.prevent_exit(),
            tauri::RunEvent::Exit => {
                som::parar_tudo();
                sistema::manter_tela_acordada(false);
            }
            _ => {}
        });
}
