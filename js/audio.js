/* ============================================================
 * audio.js - Web Audio 合成音效模块
 *
 * 不加载任何外部音频文件，全部用振荡器实时合成：
 *  优点：零网络依赖、体积小、file:// 协议下也能正常播放。
 *  注意：iOS Safari 要求 AudioContext 必须在用户手势中创建/恢复，
 *        因此提供 unlock()，在首次触摸/点击时调用。
 * ============================================================ */
(function (global) {
  'use strict';

  function Audio() {
    this.ctx = null;
    this.enabled = true;   // 音效开关（由 main 按本地存档设置）
  }

  Audio.prototype = {
    /* 在用户首次手势时调用：创建并恢复音频上下文 */
    unlock: function () {
      if (!this.ctx) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        try { this.ctx = new AC(); } catch (e) { return; }
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    },

    /**
     * 播放一个基础音符
     * @param {number} freq    起始频率 Hz
     * @param {number} dur     时长 秒
     * @param {string} type    波形 sine/square/triangle
     * @param {number} vol     音量 0~1
     * @param {number} delay   延迟播放 秒
     * @param {number} slideTo 滑音目标频率（可选）
     */
    _tone: function (freq, dur, type, vol, delay, slideTo) {
      if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
      var t0 = this.ctx.currentTime + (delay || 0);
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();

      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t0 + dur);
      }

      /* 简易包络：快速起音 + 指数衰减，避免爆音 */
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    },

    /* ---------- 各游戏事件音效 ---------- */

    /** 点选棋子：清脆小跳音 */
    select: function () {
      this._tone(720, 0.08, 'triangle', 0.16);
      this._tone(1080, 0.06, 'sine', 0.08, 0.02);
    },

    /** 交换棋子：短促滑动音 */
    swap: function () {
      this._tone(420, 0.1, 'triangle', 0.18, 0, 640);
    },

    /** 无效交换（换回来）：低沉提示 */
    bad: function () {
      this._tone(220, 0.16, 'square', 0.1, 0, 160);
    },

    /**
     * 消除：随连击数升调的琶音，连击越高越激昂
     * @param {number} combo 当前连击数（1 起）
     */
    match: function (combo) {
      var base = 520 * Math.pow(1.12, Math.min(combo - 1, 8)); // 连击升调
      this._tone(base, 0.12, 'triangle', 0.22);
      this._tone(base * 1.25, 0.12, 'triangle', 0.18, 0.05);
      this._tone(base * 1.5, 0.16, 'sine', 0.16, 0.1);
    },

    /** 特殊棋子生成：bling 闪光音 */
    special: function () {
      this._tone(880, 0.1, 'sine', 0.18);
      this._tone(1320, 0.14, 'sine', 0.16, 0.06);
      this._tone(1760, 0.2, 'sine', 0.12, 0.12);
    },

    /** 棋子下落补位：轻微嗒声 */
    fall: function () {
      this._tone(300, 0.05, 'triangle', 0.06);
    },

    /** 过关：上行琶音小号角 */
    win: function () {
      var notes = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < notes.length; i++) {
        this._tone(notes[i], 0.22, 'triangle', 0.2, i * 0.09);
      }
      this._tone(1568, 0.4, 'sine', 0.16, notes.length * 0.09);
    },

    /** 失败：下行音阶 */
    lose: function () {
      var notes = [440, 392, 330, 262];
      for (var i = 0; i < notes.length; i++) {
        this._tone(notes[i], 0.25, 'triangle', 0.16, i * 0.14);
      }
    },

    /** 按钮点击 */
    click: function () {
      this._tone(600, 0.05, 'triangle', 0.12);
    }
  };

  global.Match3 = global.Match3 || {};
  global.Match3.Audio = Audio;
})(window);
