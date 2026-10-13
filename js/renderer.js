/* ============================================================
 * renderer.js - Canvas 渲染模块（表现层，只读游戏状态）
 *
 * 职责：
 *  1. 分辨率自适应：按 CSS 尺寸 x devicePixelRatio（上限 2x）
 *     设置物理分辨率，手机高分屏下图标边缘锐利。
 *  2. 棋子绘制：糖果色圆角底板 + emoji 小动物，按棋子的
 *     gx/gy/scale/alpha 绘制（动画数值由 game.update 驱动）。
 *  3. 特殊棋子视觉：直线（条纹+箭头徽标）、炸弹（金环+星徽）、
 *     彩色星星（旋转彩虹渐变 + 白星）。
 *  4. 反馈特效：消除粒子迸溅、得分飘字、全屏横幅（连击/提示）、
 *     选中格高亮呼吸光圈。
 * ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.Match3.config;

  /* 圆角矩形路径 */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.size = 0;            // 画布物理边长
    this.cell = 0;            // 单格物理边长

    /* 表现层私有状态 */
    this.particles = [];      // 消除粒子
    this.popups = [];         // 得分飘字
    this.banner = null;       // 全屏横幅 {text, color, until, born}
    this.lastNow = 0;
  }

  Renderer.prototype = {

    /** 按容器尺寸与 DPR 重设分辨率，返回是否变化 */
    resize: function () {
      var cssSize = this.canvas.clientWidth;
      if (!cssSize) return false;
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      var size = Math.round(cssSize * dpr);
      if (size === this.size) return false;
      this.size = size;
      this.cell = size / cfg.COLS;
      this.canvas.width = size;
      this.canvas.height = size;
      return true;
    },

    /* ================= 特效触发（由 main 调用） ================= */

    /** 消除粒子迸溅 */
    burst: function (gx, gy, color) {
      var cx = (gx + 0.5) * this.cell;
      var cy = (gy + 0.5) * this.cell;
      for (var i = 0; i < 10; i++) {
        var ang = Math.random() * Math.PI * 2;
        var speed = this.cell * (0.0018 + Math.random() * 0.0035);
        this.particles.push({
          x: cx, y: cy,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed - this.cell * 0.0015,
          r: this.cell * (0.05 + Math.random() * 0.07),
          life: 420 + Math.random() * 220,
          maxLife: 640,
          color: color
        });
      }
    },

    /** 得分飘字 */
    popup: function (gx, gy, text, color) {
      this.popups.push({
        x: (gx + 0.5) * this.cell,
        y: (gy + 0.2) * this.cell,
        text: text,
        color: color || '#dc2626',
        life: 850
      });
    },

    /** 全屏横幅（连击、洗牌提示等） */
    showBanner: function (text, color, ms) {
      this.banner = {
        text: text,
        color: color || '#f59e0b',
        born: performance.now(),
        until: performance.now() + (ms || 900)
      };
    },

    /* ================= 主绘制入口 ================= */

    draw: function (game, now) {
      var ctx = this.ctx;
      var dt = Math.min(now - this.lastNow || 16, 50);
      this.lastNow = now;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.size, this.size);

      this._drawBoard(ctx);
      this._drawSelection(ctx, game, now);
      this._drawPieces(ctx, game, now);
      this._drawParticles(ctx, dt);
      this._drawPopups(ctx, dt);
      this._drawBanner(ctx, now);
    },

    /* ---------- 棋盘底 ---------- */
    _drawBoard: function (ctx) {
      var cell = this.cell, n = cfg.COLS;

      /* 整体底板：半透明白 + 圆角 */
      roundRect(ctx, 0, 0, this.size, this.size, cell * 0.28);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fill();

      /* 淡色棋盘格 */
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      var inset = cell * 0.045;
      for (var r = 0; r < n; r++) {
        for (var c = (r % 2); c < n; c += 2) {
          roundRect(ctx, c * cell + inset, r * cell + inset,
                    cell - inset * 2, cell - inset * 2, cell * 0.16);
          ctx.fill();
        }
      }
    },

    /* ---------- 选中高亮 ---------- */
    _drawSelection: function (ctx, game, now) {
      if (!game.selected || game.state !== 'ready') return;
      var cell = this.cell;
      var x = game.selected.col * cell;
      var y = game.selected.row * cell;
      var pulse = 0.5 + 0.3 * Math.sin(now / 160);

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.75 + pulse * 0.25) + ')';
      ctx.lineWidth = Math.max(3, cell * 0.07);
      ctx.shadowColor = 'rgba(251,191,36,0.9)';
      ctx.shadowBlur = cell * 0.25 * pulse;
      roundRect(ctx, x + cell * 0.05, y + cell * 0.05,
                cell * 0.9, cell * 0.9, cell * 0.2);
      ctx.stroke();
      ctx.restore();
    },

    /* ---------- 棋子 ---------- */
    _drawPieces: function (ctx, game, now) {
      var cell = this.cell;
      for (var r = 0; r < cfg.ROWS; r++) {
        for (var c = 0; c < cfg.COLS; c++) {
          var p = game.grid[r][c];
          if (!p || p.alpha <= 0.01 || p.scale <= 0.01) continue;
          this._drawPiece(ctx, p, now);
        }
      }
    },

    _drawPiece: function (ctx, p, now) {
      var cell = this.cell;
      var x = (p.gx + 0.5) * cell;
      var y = (p.gy + 0.5) * cell;
      var s = p.scale;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx.translate(x, y);
      ctx.scale(s, s);

      var half = cell * 0.42;   // 底板半边长
      var isColor = p.special === 'color';

      /* ----- 底板 ----- */
      roundRect(ctx, -half, -half, half * 2, half * 2, cell * 0.18);
      if (isColor) {
        /* 彩色星星：随时间旋转的彩虹渐变 */
        var hue = Math.floor((now / 12) % 360);
        var g = ctx.createLinearGradient(-half, -half, half, half);
        g.addColorStop(0, 'hsl(' + hue + ',90%,65%)');
        g.addColorStop(0.5, 'hsl(' + ((hue + 90) % 360) + ',90%,60%)');
        g.addColorStop(1, 'hsl(' + ((hue + 180) % 360) + ',90%,65%)');
        ctx.fillStyle = g;
      } else {
        var t = cfg.TYPES[p.type] || cfg.TYPES[0];
        ctx.fillStyle = t.bg;
      }
      ctx.fill();

      /* 底板描边 */
      ctx.lineWidth = Math.max(2, cell * 0.045);
      ctx.strokeStyle = isColor ? 'rgba(255,255,255,0.9)' : (cfg.TYPES[p.type] || cfg.TYPES[0]).color;
      ctx.stroke();

      /* 顶部高光，营造糖果质感 */
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      roundRect(ctx, -half * 0.7, -half * 0.78, half * 1.4, half * 0.5, cell * 0.12);
      ctx.fill();

      if (isColor) {
        /* 彩色星星中心：白色五角星 */
        ctx.font = Math.floor(cell * 0.58) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = cell * 0.06;
        ctx.fillText('★', 0, cell * 0.02);
        ctx.shadowBlur = 0;
      } else {
        /* ----- 特殊棋子底纹 ----- */
        if (p.special === 'row' || p.special === 'col') {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          var bw = cell * 0.1, bl = cell * 0.72;
          if (p.special === 'row') {
            ctx.fillRect(-bl / 2, -cell * 0.18, bl, bw);
            ctx.fillRect(-bl / 2, cell * 0.08, bl, bw);
          } else {
            ctx.fillRect(-cell * 0.18, -bl / 2, bw, bl);
            ctx.fillRect(cell * 0.08, -bl / 2, bw, bl);
          }
        } else if (p.special === 'bomb') {
          /* 炸弹：脉动金环 */
          var pulseR = cell * (0.34 + 0.03 * Math.sin(now / 140));
          ctx.strokeStyle = 'rgba(245,158,11,0.9)';
          ctx.lineWidth = cell * 0.06;
          ctx.beginPath();
          ctx.arc(0, 0, pulseR, 0, Math.PI * 2);
          ctx.stroke();
        }

        /* ----- emoji 主体 ----- */
        ctx.font = Math.floor(cell * 0.52) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cfg.TYPES[p.type].emoji, 0, cell * 0.03);

        /* ----- 特殊棋子角标 ----- */
        if (p.special) {
          var badge = { row: '↔', col: '↕', bomb: '✸' }[p.special];
          if (badge) {
            var bx = half * 0.62, by = half * 0.62, br = cell * 0.16;
            ctx.fillStyle = '#f59e0b';
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = cell * 0.03;
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold ' + Math.floor(cell * 0.2) + 'px sans-serif';
            ctx.fillText(badge, bx, by + cell * 0.01);
          }
        }
      }

      ctx.restore();
    },

    /* ---------- 粒子 ---------- */
    _drawParticles: function (ctx, dt) {
      for (var i = this.particles.length - 1; i >= 0; i--) {
        var p = this.particles[i];
        p.life -= dt;
        if (p.life <= 0) { this.particles.splice(i, 1); continue; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += this.cell * 0.000012 * dt; // 微重力
        ctx.globalAlpha = p.life / p.maxLife;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },

    /* ---------- 飘字 ---------- */
    _drawPopups: function (ctx, dt) {
      for (var i = this.popups.length - 1; i >= 0; i--) {
        var p = this.popups[i];
        p.life -= dt;
        if (p.life <= 0) { this.popups.splice(i, 1); continue; }
        p.y -= this.cell * 0.0011 * dt; // 上浮
        ctx.globalAlpha = Math.min(1, p.life / 400);
        ctx.font = 'bold ' + Math.floor(this.cell * 0.42) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = this.cell * 0.08;
        ctx.strokeText(p.text, p.x, p.y);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
      }
      ctx.globalAlpha = 1;
    },

    /* ---------- 横幅 ---------- */
    _drawBanner: function (ctx, now) {
      if (!this.banner) return;
      if (now > this.banner.until) { this.banner = null; return; }

      var b = this.banner;
      var age = now - b.born;
      var life = b.until - b.born;
      /* 入场回弹 + 退场淡出 */
      var enter = Math.min(age / 180, 1);
      var scale = 1 + 0.6 * (1 - enter) * (1 - enter);
      var alpha = Math.min(1, (b.until - now) / (life * 0.35));

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.translate(this.size / 2, this.size * 0.42);
      ctx.scale(scale, scale);
      ctx.font = '900 ' + Math.floor(this.cell * 0.85) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = this.cell * 0.14;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.color;
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
    }
  };

  global.Match3 = global.Match3 || {};
  global.Match3.Renderer = Renderer;
})(window);
