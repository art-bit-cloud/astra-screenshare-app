// Recebe pedaços de PCM 16 bits estéreo (do astra-audio.exe) e toca como áudio
// do navegador. Guarda um pouquinho (cerca de 40 ms) para não engasgar, e joga
// fora o excesso se acumular atraso.
class AstraSom extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tam = 48000;                       // 1 segundo de buffer circular (por canal)
    this.esq = new Float32Array(this.tam);
    this.dir = new Float32Array(this.tam);
    this.ler = 0;
    this.escrever = 0;
    this.cheio = 0;
    this.tocando = false;
    this.port.onmessage = (e) => this.receber(new Int16Array(e.data.buffer, e.data.byteOffset, e.data.byteLength >> 1));
  }

  receber(pcm) {
    const quadros = pcm.length >> 1;
    for (let i = 0; i < quadros; i++) {
      this.esq[this.escrever] = pcm[2 * i] / 32768;
      this.dir[this.escrever] = pcm[2 * i + 1] / 32768;
      this.escrever = (this.escrever + 1) % this.tam;
    }
    this.cheio += quadros;
    // Mais de 200 ms guardados = atraso: pula para perto do fim.
    if (this.cheio > 9600) {
      const pular = this.cheio - 1920;
      this.ler = (this.ler + pular) % this.tam;
      this.cheio -= pular;
    }
  }

  process(_entradas, saidas) {
    const [e, d] = saidas[0];
    const n = e.length;
    if (!this.tocando && this.cheio >= 1920) this.tocando = true;   // espera juntar 40 ms
    if (!this.tocando || this.cheio < n) {
      this.tocando = this.cheio >= n;
      return true;   // silêncio
    }
    for (let i = 0; i < n; i++) {
      e[i] = this.esq[this.ler];
      if (d) d[i] = this.dir[this.ler];
      this.ler = (this.ler + 1) % this.tam;
    }
    this.cheio -= n;
    return true;
  }
}
registerProcessor("astra-som", AstraSom);
