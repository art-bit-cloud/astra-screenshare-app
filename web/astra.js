// A.S.T.R.A - o modo "Jarvis" do programa de PC.
//
// Liga no losango do painel do usuário (ou pelo ícone perto do relógio). A janela
// vai para a tela cheia com uma abertura animada e o programa inteiro muda de
// visual (astra.css). Ganha:
//  - o núcleo no centro e o canal de comando para conversar com a A.S.T.R.A.
//    A IA fica na VPS: o servidor_tela.py repassa a pergunta para a IA gratuita
//    da NVIDIA, e a chave nunca sai de lá;
//  - a telemetria do PC (processador e memória) e a latência até a VPS;
//  - o radar tático, com os amigos online como alvos.
// A A.S.T.R.A também mexe no programa e no PC: no fim da resposta a IA pode mandar
// comandos, como [[transmitir]], [[criar_sala|Jogatina]] ou [[volume|mais]], que
// são feitos aqui (os do PC passam pelo main.js, que só aceita a lista dele).
// Ela fica ouvindo o tempo todo e responde quando alguém diz "Astra" (ou depois
// do Ctrl+Alt+A). A voz vira texto no próprio PC (whisper.cpp): o áudio do
// microfone não sai do computador. A resposta sai com uma voz natural (vozes da
// Microsoft, feitas na VPS) ou com uma voz que roda no PC; a pessoa escolhe no
// botão do alto-falante ou dizendo "Astra, troca a voz".
"use strict";
(function () {
  if (!programa || celular) return;   // só no programa de PC

  const A = {
    ligado: false,
    estado: "idle",       // idle, listen, transcribe, think, speak
    amp: 0,
    historico: [],        // conversa enviada para a IA (role/content)
    pergunta: null,       // {id, texto, el, bruto}
    falado: false,        // o último pedido veio por voz (avisos vão também para o cartão por cima do jogo)
    voz: ler("astra.voz") !== "0",       // responde falando
    vozEscolhida: ler("astra.vozEscolhida"),   // id da voz (ver catalogo())
    vozesPc: [],                               // vozes do PC (Piper) já baixadas
    preparandoVoz: false,
    transicao: 0,         // cada abertura/fechamento novo cancela o anterior
    cpu: Array.from({ length: 40 }, () => 0),
    latencia: null,
    tique: 0,
    sensores: null,
    quadro: null,
  };
  // Microfone sempre aberto (ver "ouvir o tempo todo", mais abaixo).
  const ESCUTA = {
    ligada: false, abrindo: false,
    stream: null, ctx: null, fonte: null, proc: null,
    nivel: 0,
    falandoAte: 0,        // ignora o microfone até aqui: a A.S.T.R.A está falando
    atentoAte: 0,         // até aqui não precisa dizer "Astra" (depois do "Sim?" ou do Ctrl+Alt+A)
    tAtento: null,
    ocupado: false,       // um trecho está sendo entendido
    fila: null,           // trecho esperando (só o mais novo)
    falhas: 0,
  };
  // A voz que está tocando.
  const FALA = { token: 0, fonte: null, analisador: null, dados: null };
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const calmo = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ROTULOS = {
    idle: ["Em espera", "Pronto"], think: ["Processando", "NVIDIA"], speak: ["Respondendo", "Falando"],
    listen: ["Ouvindo", "Pode falar"], transcribe: ["Entendendo", "Voz"],
  };

  // ---------- ligar e desligar ----------
  function alternarAstra(sim = !A.ligado, comAbertura = true) {
    if (sim === A.ligado) return;
    A.ligado = sim;
    const vez = ++A.transicao;
    guardar("astra.modo", sim ? "astra" : "");
    $("bt-astra").classList.toggle("ligado", sim);
    $("bt-astra").title = sim ? "Voltar para o visual normal" : "Modo A.S.T.R.A";
    document.title = sim ? "A.S.T.R.A · AstraScreenShare" : "AstraScreenShare";
    if (sim) {
      programa.modoAstra?.(true, comAbertura);      // tela cheia
      if (comAbertura && !calmo) abrirComTransicao(vez);
      else {
        mostrarVisual(true);
        if (comAbertura) { suave(); if (A.voz) setTimeout(saudar, 400); }
      }
      clearInterval(A.sensores);
      A.sensores = setInterval(sensores, 1000);
      sensores();
      if (!A.quadro) A.quadro = requestAnimationFrame(desenhar);
      iniciarVoz();
    } else {
      clearInterval(A.sensores);
      A.sensores = null;
      pararFala();
      desligarEscuta();
      fecharComTransicao(vez);
    }
  }
  window.alternarAstra = alternarAstra;
  $("bt-astra").hidden = false;
  $("bt-astra").addEventListener("click", () => alternarAstra());
  $("bt-astra-sair").addEventListener("click", () => alternarAstra(false));

  function mostrarVisual(sim) {
    document.body.classList.toggle("modo-astra", sim);
    for (const id of ["astra-topo", "astra-telemetria", "astra-radar", "astra-nucleo"]) $(id).hidden = !sim;
    if (sim) posicionarNucleo();
  }

  // Com transmissão na tela, o núcleo vira uma bolinha no canto.
  function posicionarNucleo() {
    const comVideo = !$("sala").hidden && !!$("palco").querySelector(".bloco");
    const n = $("astra-nucleo");
    n.classList.toggle("mini", comVideo);
    if (!comVideo) n.classList.remove("aberto");
    ajustarTelas();
  }
  new MutationObserver(posicionarNucleo).observe($("palco"), { childList: true });
  new MutationObserver(posicionarNucleo).observe($("sala"), { attributes: true, attributeFilter: ["hidden"] });
  $("astra-mini").addEventListener("click", () => {
    const n = $("astra-nucleo");
    n.classList.toggle("aberto");
    if (n.classList.contains("aberto")) { ajustarTelas(); $("astra-in").focus(); }
  });

  function saudacao() {
    const h = new Date().getHours();
    return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  }
  const saudar = () => falar(`A.S.T.R.A online. ${saudacao()}, ${meuNome()}.`);

  // Troca de classe que dura um tempo (a animação está no astra.css).
  function efeito(classe, ms) {
    document.body.classList.remove(classe);
    void document.body.offsetWidth;
    document.body.classList.add(classe);
    setTimeout(() => document.body.classList.remove(classe), ms);
  }
  const suave = () => efeito("astra-voltando", 500);

  // ---------- abertura: tela cheia com uma transição tecnológica ----------
  // 1) o visual normal "falha" (glitch) e apaga;
  // 2) tela escura: a linha de luz abre a tela, a grade aparece, partículas correm
  //    para o núcleo, o nome se decifra e a barra de carga enche com o diagnóstico;
  // 3) a íris abre do centro e os painéis do HUD entram, piscando como holograma.
  function abrirComTransicao(vez) {
    somLigar();
    efeito("astra-glitch", 440);
    setTimeout(() => {
      if (vez !== A.transicao) return;
      mostrarVisual(true);          // o HUD já fica pronto por baixo da abertura
      abertura(vez);
    }, 420);
  }

  function abertura(vez) {
    const caixa = $("astra-boot");
    const pre = $("astra-boot-linhas");
    const barra = $("astra-boot-progresso");
    caixa.classList.remove("abrindo");
    caixa.style.removeProperty("--astra-raio");
    caixa.hidden = false;
    pre.textContent = "";
    barra.style.width = "0%";
    let voz = "iniciando";
    programa.vozEstado?.().then((st) => {
      voz = !st.existe ? "indisponível" : st.escuta && st.pedido ? "diga “Astra”" : "preparando";
    }).catch(() => {});
    const n = estado.online.filter((p) => p.astraId !== estado.meuId).length;
    const online = !!(estado.ws && estado.ws.readyState === 1);
    const linhas = [
      () => "> núcleo neural ............. ok",
      () => "> tela cheia ................ ok",
      () => "> servidor VPS .............. " + (online ? "online" : "procurando"),
      () => "> IA NVIDIA ................. " + (estado.ia ? "pronta" : "desligada"),
      () => `> radar tático .............. ${n} ${n === 1 ? "alvo" : "alvos"}`,
      () => "> escuta por voz ............ " + voz,
      () => "> A.S.T.R.A online.",
    ];
    decifrar($("astra-boot-titulo"), "A.S.T.R.A", 1100, vez);
    animarBoot(vez);
    linhas.forEach((linha, i) => setTimeout(() => {
      if (vez !== A.transicao) return;
      pre.textContent += linha() + "\n";
      barra.style.width = `${Math.round(((i + 1) / linhas.length) * 100)}%`;
      somTique(i);
    }, 350 + i * 260));
    const revelar = 350 + linhas.length * 260 + 250;
    setTimeout(() => { if (vez === A.transicao) abrirIris(vez); }, revelar);
    if (A.voz) setTimeout(() => { if (vez === A.transicao) saudar(); }, revelar + 350);
  }

  // O nome aparece "decifrando": letras aleatórias que vão se acertando.
  function decifrar(el, final, ms, vez) {
    const sinais = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$*<>/";
    const inicio = performance.now();
    const t = setInterval(() => {
      const p = (performance.now() - inicio) / ms;
      if (vez !== A.transicao || p >= 1) { clearInterval(t); el.textContent = final; return; }
      el.textContent = [...final].map((ch, i) => (ch === "." || p > (i + 1) / final.length ? ch
        : sinais[Math.floor(Math.random() * sinais.length)])).join("");
    }, 45);
  }

  function abrirIris(vez) {
    const caixa = $("astra-boot"), anel = $("astra-iris");
    somRevelar();
    efeito("astra-entrando", 1700);
    caixa.classList.add("abrindo");
    anel.hidden = false;
    const dur = 800, inicio = performance.now();
    const maximo = Math.hypot(innerWidth, innerHeight) / 2 + 40;
    let acabou = false;
    const fim = () => {
      if (acabou) return;
      acabou = true;
      caixa.hidden = true;
      caixa.classList.remove("abrindo");
      anel.hidden = true;
      ajustarTelas();
    };
    const passo = (t) => {
      if (acabou) return;
      if (vez !== A.transicao) return fim();
      const p = Math.min(1, (t - inicio) / dur);
      const r = (1 - Math.pow(1 - p, 3)) * maximo;
      caixa.style.setProperty("--astra-raio", r.toFixed(1) + "px");
      anel.style.width = anel.style.height = (r * 2).toFixed(1) + "px";
      anel.style.opacity = String(1 - p * p);
      if (p < 1) requestAnimationFrame(passo);
      else fim();
    };
    requestAnimationFrame(passo);
    setTimeout(fim, dur + 700);        // termina mesmo se a janela parar de desenhar
  }

  // Fechar: o HUD apaga como um monitor antigo e o visual normal volta.
  function fecharComTransicao(vez) {
    $("astra-boot").hidden = true;
    $("astra-iris").hidden = true;
    const terminar = () => {
      mostrarVisual(false);
      programa.modoAstra?.(false);       // sai da tela cheia
    };
    if (calmo || !document.body.classList.contains("modo-astra")) { terminar(); return; }
    somDesligar();
    efeito("astra-desligando", 560);
    setTimeout(() => {
      if (vez !== A.transicao) return;
      terminar();
      suave();
    }, 520);
  }

  // A animação da abertura, num canvas que cobre a tela.
  function animarBoot(vez) {
    const cv = $("astra-boot-tela"), c = cv.getContext("2d");
    const inicio = performance.now();
    let w = 0, h = 0, antes = inicio, trocou = 0, leituras = [];
    const parts = Array.from({ length: 170 }, () => ({
      a: Math.random() * 6.283, d: 0.25 + Math.random() * 0.9, v: 0.18 + Math.random() * 0.4, r: 0.5 + Math.random() * 1.4,
    }));
    const hex = () => Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    const ROT = ["SYS.NUCLEO", "LINK.VPS", "AUDIO.IN", "IA.NVIDIA"];
    const quadro = (t) => {
      if (vez !== A.transicao || $("astra-boot").hidden) return;
      requestAnimationFrame(quadro);
      const s = (t - inicio) / 1000, dt = Math.min(0.05, (t - antes) / 1000);
      antes = t;
      const W = Math.round(cv.clientWidth * DPR), H = Math.round(cv.clientHeight * DPR);
      if (W !== w || H !== h) { w = cv.width = W; h = cv.height = H; }
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
      const esc = Math.max(0.85, Math.min(1.25, R / (400 * DPR))) * DPR;
      c.clearRect(0, 0, w, h);

      // 1) linha de luz que abre a tela, como um monitor ligando
      if (s < 0.6) {
        const lw = w * ease(s / 0.25), bh = h * ease((s - 0.25) / 0.3);
        c.fillStyle = `rgba(168,240,255,${0.9 * (1 - ease((s - 0.25) / 0.35))})`;
        c.fillRect(cx - lw / 2, cy - Math.max(1.5 * DPR, bh / 2), lw, Math.max(3 * DPR, bh));
      }

      // 2) grade em perspectiva (chão e teto) correndo para o centro
      const ga = 0.5 * ease((s - 0.2) / 0.6);
      if (ga > 0) {
        c.lineWidth = DPR;
        for (const lado of [1, -1]) {
          const alfa = lado > 0 ? ga : ga * 0.4;
          for (let k = 0; k < 14; k++) {
            const z = (k + ((s * 0.9) % 1)) / 14;
            const y = cy + lado * (h / 2) * z * z;
            c.strokeStyle = `rgba(79,216,255,${alfa * z})`;
            c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
          }
          c.strokeStyle = `rgba(79,216,255,${alfa * 0.45})`;
          for (let i = -12; i <= 12; i++) {
            c.beginPath(); c.moveTo(cx + i * w * 0.004, cy); c.lineTo(cx + i * w * 0.09, cy + (lado * h) / 2); c.stroke();
          }
        }
      }

      // 3) varredura: uma faixa de luz da esquerda para a direita
      if (s > 0.5 && s < 1.7) {
        const x = w * ease((s - 0.5) / 1.2), larg = 90 * DPR;
        const g = c.createLinearGradient(x - larg, 0, x, 0);
        g.addColorStop(0, "rgba(79,216,255,0)"); g.addColorStop(1, "rgba(79,216,255,.2)");
        c.fillStyle = g; c.fillRect(x - larg, 0, larg, h);
        c.fillStyle = "rgba(168,240,255,.7)"; c.fillRect(x, 0, 1.5 * DPR, h);
      }

      // 4) partículas correndo para o núcleo; no fim param de nascer e todas chegam
      const D = Math.hypot(w, h) / 2, juntar = s > 1.9;
      for (const p of parts) {
        if (p.d < 0) continue;
        p.d -= p.v * dt * (0.6 + s * 0.8);
        if (p.d < 0.04) {
          if (juntar) { p.d = -1; continue; }
          p.d = 0.9 + Math.random() * 0.4;
          p.a = Math.random() * 6.283;
        }
        const co = Math.cos(p.a), si = Math.sin(p.a);
        c.strokeStyle = `rgba(140,230,255,${Math.min(0.9, 0.25 + (1 - p.d) * 0.7) * ease(s / 0.5)})`;
        c.lineWidth = p.r * DPR;
        c.beginPath(); c.moveTo(cx + co * p.d * D, cy + si * p.d * D); c.lineTo(cx + co * (p.d + 0.035) * D, cy + si * (p.d + 0.035) * D); c.stroke();
      }

      // 5) anéis do núcleo em volta do logo, girando
      const ra = ease((s - 0.3) / 0.8);
      if (ra > 0) {
        c.save();
        c.translate(cx, cy);
        [[70, 1.5, 0.9, [4, 6]], [86, 1, -0.6, []], [102, 2, 0.4, [18, 10, 2, 10]], [118, 1, -0.25, [2, 5]]].forEach(([r, lw, v, traco], i) => {
          c.save();
          c.rotate(s * v + i);
          c.setLineDash(traco.map((x) => x * DPR));
          c.beginPath(); c.arc(0, 0, r * esc * (0.6 + 0.4 * ra), 0, Math.PI * 2 * ra);
          c.strokeStyle = `rgba(79,216,255,${0.25 + 0.45 * ra})`; c.lineWidth = lw * DPR;
          c.shadowColor = "rgba(79,216,255,.8)"; c.shadowBlur = 8 * DPR; c.stroke();
          c.restore();
        });
        c.setLineDash([]);
        c.lineWidth = DPR;
        for (let i = 0; i < 60; i++) {
          const a = (i / 60) * Math.PI * 2 - s * 0.15, r1 = 126 * esc, r2 = r1 + (i % 5 ? 4 : 9) * esc;
          c.strokeStyle = `rgba(79,216,255,${(i % 5 ? 0.2 : 0.5) * ra})`;
          c.beginPath(); c.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); c.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); c.stroke();
        }
        // o brilho do núcleo cresce com as partículas que chegam
        const brilho = 0.25 + 0.55 * ease((s - 0.8) / 1.6);
        const g = c.createRadialGradient(0, 0, 0, 0, 0, 95 * esc);
        g.addColorStop(0, `rgba(168,240,255,${brilho})`); g.addColorStop(0.5, `rgba(47,201,255,${brilho * 0.35})`); g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g; c.beginPath(); c.arc(0, 0, 95 * esc, 0, 7); c.fill();
        c.restore();
      }

      // 6) cantoneiras e leituras nos cantos, como um painel ligando
      const la = 0.65 * ease((s - 0.4) / 0.5);
      if (la > 0) {
        if (t - trocou > 90) { trocou = t; leituras = ROT.map((nome) => `${nome}  ${hex()} ${hex()} ${hex()}`); }
        const m = 30 * DPR, L = 26 * DPR, q = 14 * DPR;
        c.font = `500 ${11 * DPR}px "JetBrains Mono", monospace`;
        c.fillStyle = `rgba(79,216,255,${la})`;
        c.textAlign = "left";
        c.fillText(leituras[0], m, m + 12 * DPR); c.fillText(leituras[2], m, h - m);
        c.textAlign = "right";
        c.fillText(leituras[1], w - m, m + 12 * DPR); c.fillText(leituras[3], w - m, h - m);
        c.strokeStyle = `rgba(79,216,255,${la})`; c.lineWidth = 1.5 * DPR;
        for (const [x, y, sx, sy] of [[q, q, 1, 1], [w - q, q, -1, 1], [q, h - q, 1, -1], [w - q, h - q, -1, -1]]) {
          c.beginPath(); c.moveTo(x, y + sy * L); c.lineTo(x, y); c.lineTo(x + sx * L, y); c.stroke();
        }
      }
    };
    requestAnimationFrame(quadro);
  }

  // ---------- sons (gerados aqui, sem arquivos) ----------
  let ctxSom = null;
  function audio() {
    if (!ctxSom || ctxSom.state === "closed") { ctxSom = new AudioContext(); FALA.analisador = null; }
    if (ctxSom.state === "suspended") ctxSom.resume().catch(() => {});
    return ctxSom;
  }
  function tom(freq, ini, dur, vol, tipo = "sine", freqFim = 0) {
    try {
      const c = audio(), t0 = c.currentTime + ini;
      const o = c.createOscillator(), g = c.createGain();
      o.type = tipo;
      o.frequency.setValueAtTime(freq, t0);
      if (freqFim) o.frequency.exponentialRampToValueAtTime(freqFim, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.03, dur / 4));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch (_) {}
  }
  // Chiado que passa (whoosh): ruído num filtro que varre de uma frequência a outra.
  function chiado(ini, dur, vol, de, ate) {
    try {
      const c = audio(), t0 = c.currentTime + ini, n = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = buf;
      f.type = "bandpass";
      f.Q.value = 1.4;
      f.frequency.setValueAtTime(de, t0);
      f.frequency.exponentialRampToValueAtTime(ate, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f).connect(g).connect(c.destination);
      src.start(t0);
      src.stop(t0 + dur);
    } catch (_) {}
  }
  const somLigar = () => { chiado(0, 0.42, 0.1, 300, 5000); tom(55, 0.4, 2.1, 0.08, "triangle", 170); };
  const somTique = (i) => tom(1700 + i * 70, 0, 0.04, 0.025, "square");
  const somRevelar = () => { chiado(0, 0.8, 0.12, 7000, 250); tom(660, 0, 1.1, 0.05); tom(1320, 0.02, 1.2, 0.06); tom(1980, 0.05, 0.9, 0.03); };
  const somDesligar = () => { tom(620, 0, 0.45, 0.07, "sine", 60); chiado(0, 0.3, 0.05, 2500, 200); };
  const bip = (freq) => tom(freq, 0, 0.15, 0.12);

  // ---------- relógio, telemetria e estado ----------
  async function sensores() {
    const d = new Date();
    $("astra-hora").textContent = d.toLocaleTimeString("pt-BR", { hour12: false });
    $("astra-data").textContent = d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });

    try {
      const t = programa.telemetria ? await programa.telemetria() : null;
      if (t) {
        A.cpu.shift();
        A.cpu.push(t.cpu);
        $("astra-cpu").textContent = Math.round(t.cpu);
        $("astra-mem").textContent = t.memUsada.toFixed(1);
        $("astra-mem-total").textContent = `/ ${Math.round(t.memTotal)} GB`;
        $("astra-nucleos").textContent = t.nucleos;
      }
    } catch (_) {}
    desenharSpark();

    const online = !!(estado.ws && estado.ws.readyState === 1 && estado.conexao);
    if (A.tique++ % 3 === 0 && online) enviar({ t: "ping", n: performance.now() });
    $("astra-status").textContent = online ? "online" : "sem conexão";
    $("astra-status").classList.toggle("caiu", !online);
    $("astra-ativos").textContent = online ? "Sistemas ativos" : "Reconectando";
    $("astra-ativos").classList.toggle("caiu", !online);
    $("astra-link").textContent = online ? "estabelecido" : "perdido";
    $("astra-vps").textContent = online ? "Online" : "Caiu";
    $("astra-vps").className = online ? "ok" : "caiu";
    $("astra-ia").textContent = estado.ia ? "Pronta" : "Desligada";
    $("astra-ia").className = estado.ia ? "ok" : "aviso-b";
    $("astra-ia-tag").textContent = !estado.ia ? "desligada" : nomeCurto(estado.iaModelo) || "pronta";
    $("astra-na-sala").textContent = estado.sala ? String(estado.pares.size + 1) : "--";
    const n = estado.online.filter((p) => p.astraId !== estado.meuId).length;
    $("astra-alvos").textContent = `${String(n).padStart(2, "0")} ${n === 1 ? "alvo" : "alvos"}`;
  }

  // "nemotron-3.5-super-vl-120b-a12b" -> "nemotron-3.5-super"
  function nomeCurto(modelo) {
    let curto = "";
    for (const parte of (modelo || "").replace(/-instruct$/, "").split("-")) {
      if (curto && (curto + "-" + parte).length > 18) break;
      curto = curto ? curto + "-" + parte : parte;
    }
    return curto;
  }

  TRATAR.pong = (m) => {
    A.latencia = Math.max(0, Math.round(performance.now() - Number(m.n)));
    $("astra-latencia").textContent = `${A.latencia} ms`;
  };

  // ---------- conversar com a A.S.T.R.A ----------
  function mudarEstado(s) {
    A.estado = s;
    $("astra-estado").textContent = ROTULOS[s][0];
    $("astra-console-estado").textContent = s === "idle" && ESCUTA.ligada ? "Diga “Astra”" : ROTULOS[s][1];
  }

  function adicionar(tipo, texto) {
    const caixa = $("astra-conversa");
    caixa.querySelector(".astra-dica")?.remove();
    const p = document.createElement("p");
    p.className = "astra-msg " + tipo;
    p.textContent = texto;
    caixa.append(p);
    while (caixa.children.length > 30) caixa.firstElementChild.remove();
    caixa.scrollTop = caixa.scrollHeight;
    return p;
  }

  // Tira os comandos [[...]] do texto (e, durante a resposta, um comando ainda pela metade).
  function semComandos(t, parcial) {
    let s = t.replace(/\[\[[^\]]*\]\]/g, "");
    if (parcial) s = s.replace(/\[\[[^\]]*$/, "").replace(/\[$/, "");
    return s.replace(/[*_`#]+/g, "").trim();
  }

  function separar(bruto) {
    const comandos = [];
    bruto.replace(/\[\[\s*([a-z_]+)\s*(?:\|([^\]]*))?\]\]/gi, (_, nome, valor) => {
      comandos.push({ nome: nome.toLowerCase(), valor: (valor || "").trim() });
      return "";
    });
    return { texto: semComandos(bruto, false), comandos };
  }

  function perguntar(texto, falado = false) {
    if (A.pergunta) enviar({ t: "ia-parar", id: A.pergunta.id });
    A.pergunta = null;
    A.falado = falado;
    ESCUTA.atentoAte = 0;
    pararFala();
    adicionar(falado ? "voce falado" : "voce", texto);
    const outraVoz = pedidoDeVoz(texto);
    if (outraVoz) { escolherVoz(outraVoz); return; }
    if (!(estado.ws && estado.ws.readyState === 1)) { nota("Sem conexão com o servidor agora."); mudarEstado("idle"); return; }
    if (!estado.ia) {
      nota("A IA ainda não foi ligada na VPS. Quem cuida da VPS precisa rodar o configurar-ia.sh (está no manual).");
      mudarEstado("idle");
      return;
    }
    const id = Math.random().toString(36).slice(2, 10);
    A.pergunta = { id, texto, el: adicionar("ia", ""), bruto: "", falado };
    mudarEstado("think");
    enviar({ t: "ia", id, texto, historico: A.historico.slice(-10),
             contexto: { transmitindo: souAoVivo(), relaxado: estado.relaxado, voz: falado } });
    setTimeout(() => {
      const p = A.pergunta;
      if (p && p.id === id && !p.bruto) {
        enviar({ t: "ia-parar", id });
        A.pergunta = null;
        p.el.className = "astra-msg erro";
        p.el.textContent = "A IA demorou demais para responder. Tente de novo.";
        if (p.falado) cartao(p.el.textContent);
        mudarEstado("idle");
      }
    }, 60000);
  }

  TRATAR.ia = (m) => {
    const p = A.pergunta;
    if (!p || p.id !== m.id) return;
    if (m.delta) {
      p.bruto += m.delta;
      if (A.estado === "think") mudarEstado("speak");
      p.el.textContent = semComandos(p.bruto, true);
      $("astra-conversa").scrollTop = $("astra-conversa").scrollHeight;
    }
    if (m.erro) {
      A.pergunta = null;
      p.el.className = "astra-msg erro";
      p.el.textContent = m.erro;
      if (p.falado) cartao(m.erro);
      mudarEstado("idle");
      return;
    }
    if (m.fim) {
      A.pergunta = null;
      const { texto, comandos } = separar(p.bruto);
      p.el.textContent = texto || (comandos.length ? "Feito." : "...");
      if (p.bruto) {
        A.historico.push({ role: "user", content: p.texto }, { role: "assistant", content: p.bruto });
        A.historico = A.historico.slice(-12);
      }
      // Até 3 comandos, um depois do outro (ex.: abrir o YouTube e aumentar o volume).
      comandos.slice(0, 3).forEach((c, i) => setTimeout(() => executar(c), i * 700));
      if (p.falado) cartao(texto || "Feito.");
      if (A.voz && texto) falar(texto);
      else mudarEstado("idle");
    }
  };

  // ---------- os comandos que a A.S.T.R.A pode dar ----------
  function acharPessoa(alvo) {
    const busca = (alvo || "").trim().toLowerCase();
    if (!busca) return null;
    const outros = estado.online.filter((p) => p.astraId !== estado.meuId);
    return outros.find((p) => p.nome.toLowerCase() === busca)
        || outros.find((p) => p.nome.toLowerCase().includes(busca))
        || outros.find((p) => busca.includes(p.nome.toLowerCase()))
        || null;
  }

  // Aviso do sistema. Se o pedido foi por voz, aparece também no cartão por cima do jogo.
  const nota = (texto) => { adicionar("erro", texto); if (A.falado) cartao(texto); };
  const cartao = (texto) => programa.popupAstra?.({ id: "voz", texto });

  // Ações no PC: quem faz é o main.js (volume, navegador, abrir sites e programas).
  const noPc = (acao) => (v) => programa.pc?.(acao, v)
    .then((r) => { if (r && !r.ok && r.erro) nota(r.erro); else if (r && r.aviso) nota(r.aviso); })
    .catch(() => nota("Não consegui fazer isso no PC."));

  const ACOES = {
    criar_sala(v) {
      const nome = (v || "").slice(0, 40) || `Sala de ${meuNome()}`;
      guardar("astra.nomeSala", nome);
      if (estado.sala && estado.sala !== estado.meuId) sairDaSala();
      enviar({ t: "criar", nomeSala: nome });
    },
    entrar(v) {
      const id = (v || "").replace(/\D/g, "");
      if (id.length === 9) return entrarNaSala(id);
      const p = acharPessoa(v);
      if (p && p.sala) entrarNaSala(p.sala);
      else nota(p ? `${p.nome} não está em nenhuma sala agora.` : `Não achei "${v}" na lista de online.`);
    },
    sair_sala() { if (estado.sala) sairDaSala(); },
    transmitir() {
      if (souAoVivo()) return;
      if (!estado.sala) ACOES.criar_sala("");
      window.astraSeletor.abrir();
    },
    parar_transmissao() { pararTela(); },
    chat(v) {
      if (!estado.sala) return nota("Entre numa sala para mandar mensagem no chat.");
      if (v) enviar({ t: "chat", texto: v.slice(0, 500) });
    },
    relaxado() {
      if (!estado.sala) return nota("Entre numa sala para assistir relaxado.");
      if (!souAoVivo()) $("bt-relaxado").click();
    },
    acorde() {
      if (souAoVivo()) $("bt-acorde").click();
      else nota("A campainha só funciona enquanto você está transmitindo.");
    },
    convidar(v) {
      const p = acharPessoa(v);
      if (!estado.sala) nota("Entre numa sala antes de convidar alguém.");
      else if (p) convidar(p);
      else nota(`Não achei "${v}" na lista de online.`);
    },
    modo_normal() { setTimeout(() => alternarAstra(false), 1800); },
    abrir_site: noPc("abrir_site"),
    pesquisar: noPc("pesquisar"),
    youtube: noPc("youtube"),
    abrir_app: noPc("abrir_app"),
    volume: noPc("volume"),
    midia: noPc("midia"),
    navegador: noPc("navegador"),
    pc: noPc("pc"),
  };

  function executar(c) {
    const acao = ACOES[c.nome];
    if (!acao) return;
    try { acao(c.valor); } catch (e) { console.warn("A.S.T.R.A", c, e); }
  }

  // ---------- preparar a voz ----------
  // Na primeira vez que o modo liga, o programa baixa o que falta para ouvir (uma
  // vez só): o "ouvido" (modelo leve, que só procura o nome) e o reconhecimento dos
  // pedidos. A voz que responde vem da VPS; uma voz do PC só é baixada se escolhida.
  async function iniciarVoz() {
    if (!programa.vozEstado || A.preparandoVoz) return;
    A.preparandoVoz = true;
    try {
      const st = await programa.vozEstado();
      if (!st.existe) return;              // fora do Windows ou instalação sem o reconhecimento
      A.vozesPc = st.vozesProntas || [];
      const escolhida = catalogo().find((v) => v.id === A.vozEscolhida);
      const faltaPc = escolhida && escolhida.tipo === "pc" && !A.vozesPc.includes(escolhida.piper) ? escolhida.piper : "";
      if (!st.escuta || !st.pedido || faltaPc) {
        const mb = (st.escuta ? 0 : 60) + (st.pedido ? 0 : 190) + (faltaPc ? 85 : 0);
        const el = adicionar("erro", "");
        const texto = (extra) => `Preparando a voz da A.S.T.R.A (cerca de ${mb} MB, uma vez só)... ${extra}`;
        el.textContent = texto("");
        programa.aoProgressoVoz((p) => { if (p.total) el.textContent = texto(`${p.etapa}: ${Math.floor((p.feito * 100) / p.total)}%`); });
        const r = await programa.vozPreparar(faltaPc);
        programa.aoProgressoVoz(null);
        if (!r.ok) { el.textContent = r.erro; return; }
        A.vozesPc = (await programa.vozEstado()).vozesProntas || [];
        el.textContent = r.erro ? `${r.erro} Já dá para chamar: diga “Astra” e o pedido.`
          : "Voz pronta! É só chamar: diga “Astra” e o pedido.";
        if (A.ligado && A.voz) falar("Pronto. Agora é só me chamar.");
      }
      if (A.ligado) ligarEscuta();
    } catch (e) {
      console.warn("A.S.T.R.A voz", e);
    } finally {
      A.preparandoVoz = false;
    }
  }

  // ---------- ouvir o tempo todo ----------
  // Com o modo ligado, o microfone fica aberto. Cada trecho de fala (até a pessoa
  // ficar 0,8 s em silêncio) passa pelo modelo leve, só para ver se chamaram
  // "Astra". Se chamaram, o modelo bom entende o pedido e o texto vai para a IA.
  // Enquanto a A.S.T.R.A fala, o microfone é ignorado, para ela não ouvir a si mesma.
  async function ligarEscuta() {
    if (ESCUTA.ligada || ESCUTA.abrindo || !A.ligado) return;
    ESCUTA.abrindo = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!A.ligado) { stream.getTracks().forEach((t) => t.stop()); return; }
      const ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const fonte = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = segmentador(ctx.sampleRate);
      fonte.connect(proc);
      proc.connect(ctx.destination);       // a saída é silêncio; só faz o processador rodar
      Object.assign(ESCUTA, { ligada: true, stream, ctx, fonte, proc, falhas: 0 });
      // Microfone desconectado: tenta de novo daqui a pouco.
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        desligarEscuta();
        if (A.ligado) setTimeout(ligarEscuta, 3000);
      });
      if (A.estado === "idle") mudarEstado("idle");
    } catch (e) {
      console.warn("A.S.T.R.A microfone", e);
      nota("Não consegui abrir o microfone. Confira se ele está ligado e liberado em Configurações do Windows → Privacidade → Microfone. Enquanto isso, dá para digitar.");
    } finally {
      ESCUTA.abrindo = false;
    }
  }

  function desligarEscuta() {
    const e = ESCUTA;
    if (e.proc) { e.proc.onaudioprocess = null; e.proc.disconnect(); }
    e.fonte?.disconnect();
    e.stream?.getTracks().forEach((t) => t.stop());
    e.ctx?.close().catch(() => {});
    clearTimeout(e.tAtento);
    Object.assign(e, { ligada: false, stream: null, ctx: null, fonte: null, proc: null, nivel: 0, fila: null, atentoAte: 0 });
  }

  // Corta o som do microfone em trechos de fala: começa quando o som passa do
  // barulho de fundo e termina com 0,8 s de silêncio (ou 10 s no máximo).
  function segmentador(taxa) {
    const ANTES = 0.35, SILENCIO = 0.8, MAXIMO = 10, MINIMO = 0.3;
    let antes = [], trecho = null, ruido = null, seguidos = 0;
    return (ev) => {
      const d = new Float32Array(ev.inputBuffer.getChannelData(0));
      const dur = d.length / taxa;
      let soma = 0;
      for (let i = 0; i < d.length; i++) soma += d[i] * d[i];
      const rms = Math.sqrt(soma / d.length);
      ESCUTA.nivel = Math.min(1, rms * 8);
      const agora = performance.now();
      if (agora < ESCUTA.falandoAte) { trecho = null; antes = []; seguidos = 0; return; }
      if (ruido === null) ruido = rms;
      const limiar = Math.max(0.012, Math.min(ruido, 0.04) * 2.5);
      if (!trecho) {
        antes.push(d);
        if (antes.length > Math.ceil(ANTES / dur) + 2) antes.shift();   // guarda o comecinho da palavra
        if (rms > limiar) seguidos++;
        else { seguidos = 0; ruido = ruido * 0.95 + rms * 0.05; }        // aprende o barulho de fundo
        if (seguidos >= 2) {
          trecho = { pedacos: antes, dur: antes.length * dur, fala: 2 * dur, silencio: 0, soma: 0, n: 0, inicio: agora - antes.length * dur * 1000 };
          antes = [];
          seguidos = 0;
        }
        return;
      }
      trecho.pedacos.push(d);
      trecho.dur += dur;
      trecho.soma += rms;
      trecho.n++;
      if (rms > limiar * 0.75) { trecho.fala += dur; trecho.silencio = 0; } else trecho.silencio += dur;
      if (trecho.silencio >= SILENCIO || trecho.dur >= MAXIMO) {
        const t = trecho;
        trecho = null;
        // Som alto o tempo todo (música, ventilador): sobe o "barulho de fundo".
        if (t.dur >= MAXIMO && t.silencio < 0.2) ruido = Math.max(ruido, (t.soma / Math.max(1, t.n)) * 0.8);
        if (t.fala >= MINIMO) entregar(t, taxa);
      }
    };
  }

  function entregar(t, taxa) {
    // Tira o silêncio do fim (deixa um pouquinho).
    let sobra = Math.floor(Math.max(0, t.silencio - 0.25) * taxa);
    const p = t.pedacos;
    while (sobra > 0 && p.length) {
      const ult = p[p.length - 1];
      if (ult.length <= sobra) { sobra -= ult.length; p.pop(); } else { p[p.length - 1] = ult.subarray(0, ult.length - sobra); sobra = 0; }
    }
    const seg = { amostras: reamostrar(p, taxa), atento: t.inicio < ESCUTA.atentoAte };
    if (ESCUTA.ocupado) ESCUTA.fila = seg;
    else processar(seg);
  }

  async function processar(seg) {
    ESCUTA.ocupado = true;
    try {
      const wav = paraWav(seg.amostras);
      const atento = seg.atento || performance.now() < ESCUTA.atentoAte;
      if (!atento) {
        const r = await programa.vozEscutar(wav);
        if (!r || !r.ok) return falhou(r);
        if (!acharNome(r.texto)) return;             // conversa normal, não chamaram a Astra
      }
      if (!A.ligado) return;
      A.falado = true;
      mudarEstado("transcribe");
      cartao("Entendendo...");
      const dica = dicaDeVoz();
      const r = await programa.vozTranscrever(wav, dica);
      if (!r || !r.ok) return falhou(r);
      ESCUTA.falhas = 0;
      const texto = r.texto || "";
      const nome = acharNome(texto);
      if (!texto || vazouDica(texto, dica) || (!atento && !nome)) {
        // Não era com ela (ou não deu para entender): volta a esperar.
        if (atento) abrirAtencao(6000);
        else { mudarEstado("idle"); cartao(""); }
        return;
      }
      if (nome && !sobraPedido(texto, nome)) { chamaram(texto); return; }   // só "Astra"
      cartao("Você: " + texto);
      perguntar(texto, true);
    } catch (e) {
      console.warn("A.S.T.R.A escuta", e);
    } finally {
      ESCUTA.ocupado = false;
      if (A.estado === "transcribe") mudarEstado("idle");
      const prox = ESCUTA.fila;
      ESCUTA.fila = null;
      if (prox && A.ligado) processar(prox);
    }
  }

  function falhou(r) {
    if (A.estado === "transcribe") mudarEstado("idle");
    // Avisa só na primeira falha; depois de várias seguidas, para de ouvir.
    if (++ESCUTA.falhas === 1 && r && r.erro) nota(r.erro);
    if (ESCUTA.falhas >= 4) {
      desligarEscuta();
      nota("O reconhecimento de voz falhou várias vezes, então parei de ouvir. Desligue e ligue o modo A.S.T.R.A para tentar de novo.");
    }
  }

  // Chamaram só "Astra": ela responde e espera o pedido sem precisar do nome.
  function chamaram(texto) {
    const respostas = ["Sim?", "Pois não?", "Estou ouvindo.", "Pode falar."];
    const f = respostas[Math.floor(Math.random() * respostas.length)];
    adicionar("voce falado", texto);
    adicionar("ia", f);
    cartao(f);
    if (A.voz) falar(f, () => abrirAtencao(8000));
    else { bip(880); abrirAtencao(8000); }
  }

  function abrirAtencao(ms) {
    ESCUTA.atentoAte = performance.now() + ms;
    mudarEstado("listen");
    clearTimeout(ESCUTA.tAtento);
    ESCUTA.tAtento = setTimeout(() => {
      if (A.estado === "listen") { mudarEstado("idle"); if (A.falado) cartao(""); }
    }, ms + 100);
  }

  // Ctrl+Alt+A (funciona com o jogo na frente): para a fala e ouve sem precisar do nome.
  function atalho() {
    if (!A.ligado) return;
    A.falado = true;
    if (!ESCUTA.ligada) {
      nota(A.preparandoVoz ? "A voz ainda está sendo preparada. Espere terminar o download." : "O microfone não está ligado.");
      return;
    }
    pararFala();
    bip(880);
    cartao("Ouvindo...");
    abrirAtencao(8000);
  }
  programa.aoAtalhoVoz?.(atalho);

  // Procura "Astra" no começo ou no fim da frase, aceitando uma letra errada do
  // reconhecimento ("Astro", "Hastra", "Ástra"...). Devolve {i, n} ou null.
  function palavrasDe(texto) {
    return String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\b([a-z])\.(?=[a-z])/g, "$1")      // "a.s.t.r.a" -> "astra"
      .split(/[^a-z0-9]+/).filter(Boolean);
  }
  function distancia(a, b) {
    let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      ant = cur;
    }
    return ant[b.length];
  }
  const ehAstra = (p) => p.length >= 4 && p.length <= 7 && distancia(p, "astra") <= 1;
  function acharNome(texto) {
    const p = palavrasDe(texto);
    for (let i = 0; i < p.length; i++) {
      if (i >= 4 && i < p.length - 2) continue;
      if (ehAstra(p[i])) return { i, n: 1 };
      if (i + 1 < p.length && ehAstra(p[i] + p[i + 1])) return { i, n: 2 };   // "as tra"
    }
    return null;
  }
  const ENFEITES = new Set(["ei", "oi", "o", "e", "ai", "ah", "eh", "hey", "hum", "ok", "okay", "ue"]);
  function sobraPedido(texto, nome) {
    const p = palavrasDe(texto);
    p.splice(nome.i, nome.n);
    return p.some((w) => !ENFEITES.has(w));
  }

  // Dica para o reconhecimento: nomes que ele erraria (programas e quem está online).
  function dicaDeVoz() {
    const nomes = estado.online.filter((p) => p.astraId !== estado.meuId).map((p) => p.nome).slice(0, 15).join(", ");
    return "Astra, YouTube, Discord, Spotify, Steam, Chrome, Twitch." + (nomes ? ` ${nomes}.` : "");
  }
  // No silêncio, o whisper às vezes "repete" a dica. Isso não é pedido.
  function vazouDica(texto, dica) {
    const d = new Set(palavrasDe(dica));
    const p = palavrasDe(texto).filter((w) => !ehAstra(w));
    return p.length >= 2 && p.every((w) => d.has(w));
  }

  function reamostrar(pedacos, taxa) {
    const n = pedacos.reduce((s, p) => s + p.length, 0);
    const tudo = new Float32Array(n);
    let o = 0;
    for (const p of pedacos) { tudo.set(p, o); o += p.length; }
    if (taxa === 16000) return tudo;
    const r = taxa / 16000;
    const saida = new Float32Array(Math.floor(n / r));
    for (let i = 0; i < saida.length; i++) {
      const a = Math.floor(i * r), b = Math.min(n, Math.floor((i + 1) * r));
      let s = 0;
      for (let j = a; j < b; j++) s += tudo[j];
      saida[i] = b > a ? s / (b - a) : tudo[a];
    }
    return saida;
  }

  function paraWav(a) {
    const buf = new ArrayBuffer(44 + a.length * 2);
    const v = new DataView(buf);
    const txt = (pos, t) => { for (let i = 0; i < t.length; i++) v.setUint8(pos + i, t.charCodeAt(i)); };
    txt(0, "RIFF"); v.setUint32(4, 36 + a.length * 2, true); txt(8, "WAVE"); txt(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    txt(36, "data"); v.setUint32(40, a.length * 2, true);
    for (let i = 0; i < a.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, a[i])) * 32767, true);
    return new Uint8Array(buf);
  }

  // ---------- falar ----------
  // Vozes, da mais natural para a mais simples:
  //  - "internet": as vozes neurais da Microsoft (Francisca, Thalita...), feitas na VPS;
  //  - "pc": as vozes do Piper, que rodam no próprio PC (masculinas; baixadas se escolhidas);
  //  - "windows": a voz do Windows (robótica), quando nenhuma outra funciona.
  const VOZES_PC = ["faber", "cadu", "jeff"];
  function catalogo() {
    const lista = (estado.vozes || []).map((v) => ({ id: v.id, nome: v.nome, genero: v.genero, tipo: "internet" }));
    for (const n of VOZES_PC) lista.push({ id: "pc:" + n, nome: n[0].toUpperCase() + n.slice(1), genero: "masculina", tipo: "pc", piper: n });
    lista.push({ id: "windows", nome: "Windows", genero: "", tipo: "windows" });
    return lista;
  }
  // A voz em uso: a escolhida; senão a primeira natural (feminina); senão a do PC; senão a do Windows.
  function vozAtual() {
    const lista = catalogo();
    const pronta = (v) => v.tipo !== "pc" || A.vozesPc.includes(v.piper);
    return lista.find((v) => v.id === A.vozEscolhida && pronta(v))
        || lista.find((v) => v.tipo === "internet")
        || lista.find((v) => v.tipo === "pc" && pronta(v))
        || lista[lista.length - 1];
  }

  function paraFalar(t) {
    return String(t || "").replace(/A\.S\.T\.R\.A\.?/g, "Astra").replace(/https?:\/\/\S+/g, "")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, "").replace(/\s+/g, " ").trim();
  }
  // Fala frase por frase: a primeira começa logo, enquanto a próxima é preparada.
  function frases(t) {
    const saida = [];
    for (const parte of t.match(/[^.!?…]+[.!?…]*/g) || [t]) {
      const s = parte.trim();
      if (!s) continue;
      if (saida.length && saida[saida.length - 1].length < 40) saida[saida.length - 1] += " " + s;
      else saida.push(s);
    }
    return saida;
  }

  // A VPS transforma a frase em áudio (MP3) e manda de volta pelo WebSocket.
  const FALAS = new Map();      // id -> função que recebe o áudio
  TRATAR.fala = (m) => {
    const receber = FALAS.get(m.id);
    if (!receber) return;
    FALAS.delete(m.id);
    receber(m.audio ? Uint8Array.from(atob(m.audio), (c) => c.charCodeAt(0)) : null);
  };
  function falaDaInternet(texto, voz) {
    if (!(estado.ws && estado.ws.readyState === 1)) return Promise.resolve(null);
    const id = Math.random().toString(36).slice(2, 10);
    return new Promise((receber) => {
      FALAS.set(id, receber);
      enviar({ t: "fala", id, texto, voz });
      setTimeout(() => { if (FALAS.delete(id)) receber(null); }, 15000);
    });
  }
  async function sintetizar(texto, voz) {
    if (voz.tipo === "internet") return falaDaInternet(texto, voz.id);
    if (voz.tipo === "pc" && programa.fala) {
      const r = await programa.fala(texto, voz.piper).catch(() => null);
      return r && r.ok ? r.wav : null;
    }
    return null;
  }

  function pararFala() {
    FALA.token++;
    try { FALA.fonte?.stop(); } catch (_) {}
    FALA.fonte = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (ESCUTA.falandoAte === Infinity) ESCUTA.falandoAte = performance.now() + 300;
  }

  async function falar(texto, depois) {
    pararFala();
    const vez = FALA.token;
    let feito = false;
    const fim = () => {
      if (feito || vez !== FALA.token) return;
      feito = true;
      FALA.fonte = null;
      ESCUTA.falandoAte = performance.now() + 600;     // o eco da última palavra
      if (!A.pergunta && A.estado === "speak") mudarEstado("idle");
      if (depois) depois();
    };
    texto = paraFalar(texto);
    if (!texto) return fim();
    ESCUTA.falandoAte = Infinity;
    mudarEstado("speak");
    const voz = vozAtual();
    if (voz.tipo === "windows") return falarWindows(texto, vez, fim);
    const partes = frases(texto);
    let proxima = sintetizar(partes[0], voz);
    for (let i = 0; i < partes.length; i++) {
      const som = await proxima;
      if (vez !== FALA.token) return;
      if (!som) {
        if (i === 0) return falarWindows(texto, vez, fim);   // a voz escolhida falhou: usa a do Windows
        break;
      }
      proxima = i + 1 < partes.length ? sintetizar(partes[i + 1], voz) : null;
      await tocar(som, vez);
      if (vez !== FALA.token) return;
    }
    fim();
  }

  async function tocar(som, vez) {
    const c = audio();
    let buf;
    try { buf = await c.decodeAudioData(som.buffer.slice(som.byteOffset, som.byteOffset + som.byteLength)); } catch (_) { return; }
    if (vez !== FALA.token) return;
    if (!FALA.analisador) {
      FALA.analisador = c.createAnalyser();
      FALA.analisador.fftSize = 512;
      FALA.dados = new Uint8Array(FALA.analisador.fftSize);
      FALA.analisador.connect(c.destination);
    }
    const fonte = c.createBufferSource();
    fonte.buffer = buf;
    fonte.connect(FALA.analisador);
    FALA.fonte = fonte;
    return new Promise((ok) => {
      const limite = setTimeout(ok, buf.duration * 1000 + 1500);   // se o som travar, não fica surda
      fonte.onended = () => { clearTimeout(limite); ok(); };
      fonte.start();
    });
  }

  // Volume da voz agora (0 a 1), para o núcleo pulsar junto.
  function nivelFala() {
    if (!FALA.fonte || !FALA.analisador) return -1;
    FALA.analisador.getByteTimeDomainData(FALA.dados);
    let soma = 0;
    for (const v of FALA.dados) soma += (v - 128) * (v - 128);
    return Math.sqrt(soma / FALA.dados.length) / 128;
  }

  function vozPt() {
    const vozes = speechSynthesis.getVoices();
    return vozes.find((v) => /pt[-_]BR/i.test(v.lang) && /francisca|maria|thalita|luciana|female|feminina/i.test(v.name))
        || vozes.find((v) => /pt[-_]BR/i.test(v.lang))
        || vozes.find((v) => /^pt/i.test(v.lang))
        || null;
  }

  function falarWindows(texto, vez, fim) {
    if (!("speechSynthesis" in window)) return fim();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "pt-BR";
    const v = vozPt();
    if (v) u.voice = v;
    u.rate = 1.05;
    u.onend = u.onerror = fim;
    speechSynthesis.speak(u);
    setTimeout(() => { if (vez === FALA.token && ESCUTA.falandoAte === Infinity) fim(); }, 2000 + texto.length * 90);
  }

  // ---------- trocar a voz (pelo menu do alto-falante ou falando) ----------
  // "Astra, troca a voz", "Astra, voz masculina", "Astra, usa a voz da Thalita"...
  function pedidoDeVoz(texto) {
    const p = palavrasDe(texto);
    if (!p.includes("voz")) return null;
    const todas = catalogo();
    const pedida = todas.find((v) => p.includes(palavrasDe(v.nome)[0]));
    if (pedida) return pedida;
    const naturais = todas.filter((v) => v.tipo === "internet");
    const opcoes = naturais.length ? naturais : todas.filter((v) => v.tipo === "pc");
    const atual = vozAtual();
    const genero = p.some((w) => /^(feminin|mulher|moca)/.test(w)) ? "feminina"
      : p.some((w) => /^(masculin|homem|moco)/.test(w)) ? "masculina" : "";
    if (genero) return opcoes.find((v) => v.genero === genero && v.id !== atual.id) || opcoes.find((v) => v.genero === genero) || null;
    if (p.some((w) => /^(troc|troqu|mud|outr|altern|diferent)/.test(w))) {
      return opcoes[(opcoes.findIndex((v) => v.id === atual.id) + 1) % opcoes.length] || null;
    }
    return null;
  }

  async function escolherVoz(v) {
    if (v.tipo === "pc" && !A.vozesPc.includes(v.piper)) {
      const el = adicionar("erro", `Baixando a voz ${v.nome} (cerca de 85 MB na primeira voz do PC, depois 60 MB)...`);
      programa.aoProgressoVoz?.((p) => { if (p.total) el.textContent = `Baixando a voz ${v.nome}... ${Math.floor((p.feito * 100) / p.total)}%`; });
      const r = await programa.falaBaixar?.(v.piper).catch(() => null);
      programa.aoProgressoVoz?.(null);
      if (!r || !r.ok) { el.textContent = `Não consegui baixar a voz ${v.nome} agora. Confira a internet e tente de novo.`; return; }
      el.remove();
      A.vozesPc.push(v.piper);
    }
    A.vozEscolhida = v.id;
    guardar("astra.vozEscolhida", v.id);
    if (!$("astra-vozes").hidden) montarMenuVozes();
    const f = v.tipo === "windows" ? "Certo, vou usar a voz do Windows."
      : `Pronto, agora eu falo com a voz ${v.genero === "feminina" ? "da" : "do"} ${v.nome}.`;
    adicionar("ia", f);
    if (A.falado) cartao(f);
    if (A.voz) falar(f);
  }

  function montarMenuVozes() {
    const menu = $("astra-vozes");
    menu.textContent = "";
    const titulo = document.createElement("div");
    titulo.className = "astra-vozes-h";
    titulo.textContent = "Voz da A.S.T.R.A";
    menu.append(titulo);
    const atual = vozAtual();
    for (const v of catalogo()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "astra-voz-item" + (v.id === atual.id ? " escolhida" : "");
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(v.id === atual.id));
      const nome = document.createElement("b");
      nome.textContent = v.tipo === "windows" ? "Voz do Windows" : v.nome;
      const info = document.createElement("small");
      info.textContent = v.tipo === "internet" ? `${v.genero}, natural`
        : v.tipo === "pc" ? `${v.genero}, roda no PC${A.vozesPc.includes(v.piper) ? "" : " (baixa)"}`
        : "robótica";
      b.append(nome, info);
      b.addEventListener("click", () => { A.falado = false; escolherVoz(v); });
      menu.append(b);
    }
    const liga = document.createElement("button");
    liga.type = "button";
    liga.className = "astra-voz-item liga";
    liga.setAttribute("role", "menuitemcheckbox");
    liga.setAttribute("aria-checked", String(A.voz));
    liga.textContent = A.voz ? "Responder falando: ligado" : "Responder falando: desligado";
    liga.addEventListener("click", () => {
      A.voz = !A.voz;
      guardar("astra.voz", A.voz ? "1" : "0");
      if (!A.voz) pararFala();
      desenharVoz();
      montarMenuVozes();
    });
    menu.append(liga);
  }

  function abrirMenuVozes(sim = $("astra-vozes").hidden) {
    if (sim) montarMenuVozes();
    $("astra-vozes").hidden = !sim;
    $("astra-voz").setAttribute("aria-expanded", String(sim));
  }
  function desenharVoz() {
    $("astra-voz").setAttribute("aria-pressed", String(A.voz));
    $("astra-voz").title = A.voz ? "Voz da A.S.T.R.A" : "Voz da A.S.T.R.A (respostas sem som)";
  }
  $("astra-voz").addEventListener("click", (e) => { e.stopPropagation(); abrirMenuVozes(); });
  document.addEventListener("click", (e) => {
    if (!$("astra-vozes").hidden && !$("astra-vozes").contains(e.target)) abrirMenuVozes(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("astra-vozes").hidden) abrirMenuVozes(false); });
  desenharVoz();

  $("astra-nova").addEventListener("click", () => {
    if (A.pergunta) enviar({ t: "ia-parar", id: A.pergunta.id });
    A.pergunta = null;
    A.historico = [];
    pararFala();
    $("astra-conversa").innerHTML = '<p class="astra-dica">Conversa nova. A A.S.T.R.A esqueceu o que foi dito antes.</p>';
    mudarEstado("idle");
  });

  $("astra-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const texto = $("astra-in").value.trim();
    if (!texto) return;
    $("astra-in").value = "";
    perguntar(texto);
  });
  $("astra-core").addEventListener("click", () => $("astra-in").focus());
  $("astra-core").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("astra-in").focus(); } });

  // ---------- desenhos (núcleo, onda, radar, gráfico e estrelas) ----------
  const telas = {};
  function ajustar(id) {
    const c = $(id);
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * DPR));
    c.height = Math.max(1, Math.round(r.height * DPR));
    telas[id] = c.getContext("2d");
  }
  let estrelas = [];
  function ajustarTelas() {
    if (!A.ligado) return;
    for (const id of ["astra-core", "astra-onda", "astra-radar-tela", "astra-spark", "astra-estrelas"]) ajustar(id);
    const c = $("astra-estrelas");
    estrelas = Array.from({ length: 90 }, () => [Math.random() * c.width, Math.random() * c.height, Math.random() * 1.4 + 0.3, Math.random() * 6]);
    desenharSpark();
  }
  addEventListener("resize", ajustarTelas);

  function desenharNucleo(t) {
    const c = telas["astra-core"], cv = $("astra-core");
    if (!c || !cv.offsetParent) return;
    const w = cv.width, h = cv.height, R = Math.min(w, h) / 2, amp = A.amp;
    c.clearRect(0, 0, w, h);
    c.save();
    c.translate(w / 2, h / 2);
    const pulso = 1 + amp * 0.18;
    let g = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.62 * pulso);
    g.addColorStop(0, `rgba(140,240,255,${0.55 + amp * 0.4})`);
    g.addColorStop(0.18, `rgba(60,200,255,${0.38 + amp * 0.3})`);
    g.addColorStop(0.45, "rgba(20,110,160,.12)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, R * 0.62 * pulso, 0, 7); c.fill();
    [0.19, 0.25, 0.31, 0.37, 0.43].forEach((r, i) => {
      c.beginPath(); c.arc(0, 0, R * r * (1 + amp * 0.05 * (i + 1)), 0, 7);
      c.strokeStyle = `rgba(79,216,255,${0.22 + 0.12 * (i % 2) + amp * 0.25})`;
      c.lineWidth = (i % 2 ? 1 : 2) * DPR; c.stroke();
    });
    const pensando = A.estado === "think" || A.estado === "transcribe";
    const rapido = pensando ? 6 : 1;
    c.save(); c.rotate(t * 0.00025 * rapido); c.setLineDash([3 * DPR, 7 * DPR]);
    c.beginPath(); c.arc(0, 0, R * 0.52, 0, 7); c.strokeStyle = "rgba(79,216,255,.55)"; c.lineWidth = 2.5 * DPR; c.stroke();
    c.restore(); c.setLineDash([]);
    const arcos = [[0.70, -2.3, -0.5, 2.2, 0.00018], [0.80, 0.2, 1.5, 1.6, -0.00012], [0.80, 2.2, 3.6, 1.2, -0.00012], [0.90, -1.3, 0.9, 1.4, 0.00008], [0.62, 0.9, 2.8, 1, 0.0003]];
    const k = pensando ? 5 : 1;
    for (const [r, a0, a1, lw, v] of arcos) {
      c.beginPath(); c.arc(0, 0, R * r, a0 + t * v * k, a1 + t * v * k);
      c.strokeStyle = `rgba(79,216,255,${0.45 + amp * 0.4})`; c.lineWidth = lw * DPR;
      c.shadowColor = "rgba(79,216,255,.8)"; c.shadowBlur = 8 * DPR; c.stroke();
    }
    c.shadowBlur = 0;
    c.save(); c.rotate(-t * 0.00006);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, grande = i % 6 === 0, r1 = R * 0.955, r2 = R * (grande ? 0.92 : 0.94);
      c.beginPath(); c.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); c.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      c.strokeStyle = `rgba(79,216,255,${grande ? 0.5 : 0.2})`; c.lineWidth = DPR; c.stroke();
    }
    c.restore();
    if (amp > 0.03) {
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2 + t * 0.0004;
        const v = amp * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7 + t * 0.012) * Math.cos(i * 0.6 - t * 0.007)));
        const r1 = R * 0.47, r2 = r1 + R * 0.12 * v;
        c.beginPath(); c.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); c.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        c.strokeStyle = `rgba(168,240,255,${0.35 + v * 0.6})`; c.lineWidth = 2 * DPR; c.stroke();
      }
    }
    g = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.15 * pulso);
    g.addColorStop(0, "#ffffff"); g.addColorStop(0.35, "#b4f4ff"); g.addColorStop(0.7, "#2fc9ff"); g.addColorStop(1, "rgba(20,150,220,0)");
    c.fillStyle = g; c.shadowColor = "#4fd8ff"; c.shadowBlur = (30 + amp * 40) * DPR;
    c.beginPath(); c.arc(0, 0, R * 0.15 * pulso, 0, 7); c.fill();
    c.restore();
  }

  function desenharOnda(t) {
    const c = telas["astra-onda"], cv = $("astra-onda");
    if (!c || !cv.offsetParent) return;
    const w = cv.width, h = cv.height;
    c.clearRect(0, 0, w, h);
    c.beginPath();
    for (let x = 0; x <= w; x += 2 * DPR) {
      const p = x / w, env = Math.sin(p * Math.PI);
      const y = h / 2 + Math.sin(p * 22 + t * 0.012) * Math.cos(p * 7 - t * 0.005) * h * 0.42 * env * (0.08 + A.amp);
      if (x) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.strokeStyle = "rgba(79,216,255,.85)"; c.lineWidth = 1.5 * DPR; c.shadowColor = "#4fd8ff"; c.shadowBlur = 6 * DPR; c.stroke(); c.shadowBlur = 0;
  }

  function desenharSpark() {
    const c = telas["astra-spark"], cv = $("astra-spark");
    if (!c || !cv.offsetParent) return;
    const w = cv.width, h = cv.height, s = A.cpu;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "rgba(92,214,255,.12)"; c.lineWidth = DPR;
    for (let i = 1; i < 3; i++) { c.beginPath(); c.moveTo(0, (h * i) / 3); c.lineTo(w, (h * i) / 3); c.stroke(); }
    const pt = (i) => [(i / (s.length - 1)) * w, h - 2 * DPR - (Math.min(100, s[i]) / 100) * (h - 4 * DPR)];
    c.beginPath();
    s.forEach((_, i) => { const [x, y] = pt(i); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.strokeStyle = "#4fd8ff"; c.lineWidth = 1.4 * DPR; c.stroke();
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(79,216,255,.25)"); g.addColorStop(1, "rgba(79,216,255,0)");
    c.fillStyle = g; c.fill();
  }

  function hash(texto, semente) { let h = semente; for (const ch of texto) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }

  function desenharRadar(t) {
    const c = telas["astra-radar-tela"], cv = $("astra-radar-tela");
    if (!c || !cv.offsetParent) return;
    const w = cv.width, h = cv.height, R = Math.min(w, h) / 2 - 3 * DPR;
    c.clearRect(0, 0, w, h);
    c.save(); c.translate(w / 2, h / 2);
    const fundo = c.createRadialGradient(0, 0, 0, 0, 0, R);
    fundo.addColorStop(0, "rgba(20,90,120,.25)"); fundo.addColorStop(1, "rgba(10,40,60,.05)");
    c.fillStyle = fundo; c.beginPath(); c.arc(0, 0, R, 0, 7); c.fill();
    c.strokeStyle = "rgba(79,216,255,.28)"; c.lineWidth = DPR;
    for (const r of [0.25, 0.5, 0.75, 1]) { c.beginPath(); c.arc(0, 0, R * r, 0, 7); c.stroke(); }
    c.beginPath(); c.moveTo(-R, 0); c.lineTo(R, 0); c.moveTo(0, -R); c.lineTo(0, R); c.stroke();
    const varredura = (t * 0.0012) % (Math.PI * 2);
    for (let i = 0; i < 30; i++) {
      c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, R, varredura - (i + 1) * 0.03, varredura - i * 0.03); c.closePath();
      c.fillStyle = `rgba(79,216,255,${0.28 * (1 - i / 30)})`; c.fill();
    }
    // Cada amigo online é um alvo; quem está na minha sala fica ciano, quem está ao vivo, vermelho.
    const alvos = estado.online.filter((p) => p.astraId !== estado.meuId).slice(0, 24);
    c.font = `600 ${10 * DPR}px Rajdhani, sans-serif`;
    c.textBaseline = "middle";
    for (const p of alvos) {
      const ang = (hash(p.astraId, 7) % 6283) / 1000;
      const dist = 0.3 + (hash(p.astraId, 13) % 60) / 100;
      const x = Math.cos(ang) * R * dist, y = Math.sin(ang) * R * dist;
      const atraso = (varredura - ang + Math.PI * 4) % (Math.PI * 2);
      const brilho = Math.max(0.25, 1 - atraso / 4);
      const cor = p.transmitindo ? "255,92,122" : p.sala && p.sala === estado.sala ? "79,216,255" : "255,215,110";
      c.fillStyle = `rgba(${cor},${brilho})`; c.shadowColor = `rgb(${cor})`; c.shadowBlur = 8 * DPR;
      c.beginPath(); c.arc(x, y, 2.8 * DPR, 0, 7); c.fill(); c.shadowBlur = 0;
      if (alvos.length <= 10) {
        c.fillStyle = `rgba(207,238,250,${0.35 + brilho * 0.5})`;
        c.textAlign = x > R * 0.35 ? "right" : "left";
        c.fillText(p.nome.slice(0, 12), x + (x > R * 0.35 ? -6 : 6) * DPR, y);
      }
    }
    c.restore();
  }

  function desenharEstrelas(t) {
    const c = telas["astra-estrelas"], cv = $("astra-estrelas");
    if (!c) return;
    c.clearRect(0, 0, cv.width, cv.height);
    for (const [x, y, r, f] of estrelas) {
      c.fillStyle = `rgba(120,210,240,${0.15 + 0.25 * Math.abs(Math.sin(t * 0.0007 + f))})`;
      c.beginPath(); c.arc(x, y, r * DPR, 0, 7); c.fill();
    }
  }

  let ultimo = 0;
  function desenhar(t) {
    A.quadro = null;
    if (!A.ligado) return;
    A.quadro = requestAnimationFrame(desenhar);
    if (document.hidden || (calmo && t - ultimo < 250)) return;
    ultimo = t;
    let alvo;
    const fala = nivelFala();
    if (A.estado === "speak") alvo = fala >= 0 ? 0.15 + Math.min(0.85, fala * 4) : 0.3 + 0.55 * Math.abs(Math.sin(t * 0.013) * Math.cos(t * 0.004));
    else if (A.estado === "think" || A.estado === "transcribe") alvo = 0.18 + 0.08 * Math.sin(t * 0.01);
    else if (A.estado === "listen") alvo = 0.1 + ESCUTA.nivel * 0.9;
    else alvo = 0.04 + 0.03 * Math.sin(t * 0.0015) + ESCUTA.nivel * 0.25;   // reage de leve ao microfone
    A.amp += (alvo - A.amp) * 0.15;
    desenharNucleo(t);
    desenharOnda(t);
    desenharRadar(t);
    desenharEstrelas(t);
  }

  // Abre já no modo A.S.T.R.A se ele estava ligado quando o programa fechou.
  if (ler("astra.modo") === "astra") alternarAstra(true, false);
})();
