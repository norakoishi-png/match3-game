/* ============================================================
 * main.js - 装配层：输入、HUD、遮罩界面、存档、主循环
 *
 * 职责：
 *  1. 指针输入：点选-点选交换 + 按住滑动交换（Pointer Events
 *     统一鼠标/触屏，配合 canvas 的 touch-action:none 禁用手势冲突）
 *  2. HUD 更新：关卡/目标/分数/步数 + 目标进度条
 *  3. 遮罩界面：开始、选关、过关、失败四种面板
 *  4. 存档：已解锁关卡、音效开关（localStorage）
 *  5. 把 game 的钩子事件接到音效与渲染特效上
 * ============================================================ */
(function () {
  'use strict';

  var cfg = Match3.config;

  /* ================= 存档工具 ================= */
  var store = {
    get: function (key, def) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    }
  };

  /* ================= 元素引用 ================= */
  var canvas = document.getElementById('game-canvas');
  var overlay = document.getElementById('overlay');
  var hudLevel = document.getElementById('hud-level');
  var hudTarget = document.getElementById('hud-target');
  var hudScore = document.getElementById('hud-score');
  var hudMoves = document.getElementById('hud-moves');
  var progressFill = document.getElementById('progress-fill');
  var progressStar = document.getElementById('progress-star');
  var btnRestart = document.getElementById('btn-restart');
  var btnLevels = document.getElementById('btn-levels');
  var btnSound = document.getElementById('btn-sound');

  /* ================= 实例 ================= */
  var audio = new Match3.Audio();
  var renderer = new Match3.Renderer(canvas);

  audio.enabled = store.get(cfg.STORE.SOUND, true);
  var unlocked = Math.max(1, Math.min(store.get(cfg.STORE.UNLOCKED, 1), cfg.LEVELS.length));
  var currentLevel = unlocked - 1; // 默认进入已解锁最高关

  /* ================= 游戏钩子 ================= */
  var game = new Match3.Game({
    onHud: function (h) {
      hudLevel.textContent = h.level;
      hudTarget.textContent = h.target;
      hudScore.textContent = h.score;
      hudMoves.textContent = h.moves;
      hudMoves.classList.toggle('low', h.moves <= 5 && h.moves > 0);

      var pct = Math.min(100, Math.round(h.score / h.target * 100));
      progressFill.style.width = pct + '%';
      progressStar.classList.toggle('reached', h.score >= h.target);
    },

    onStart: function (level) {
      renderer.showBanner('第 ' + (level + 1) + ' 关', '#f59e0b', 1100);
    },

    onSwap: function () { audio.swap(); },
    onBadSwap: function () { audio.bad(); },
    onFall: function () { audio.fall(); },

    onMatch: function (cells, gained, combo, specials) {
      audio.match(combo);

      /* 粒子 + 飘字 */
      var cx = 0, cy = 0;
      for (var i = 0; i < cells.length; i++) {
        var t = cells[i].type;
        var color = t >= 0 ? cfg.TYPES[t].color : '#f59e0b';
        renderer.burst(cells[i].col, cells[i].row, color);
        cx += cells[i].col; cy += cells[i].row;
      }
      if (cells.length) {
        renderer.popup(cx / cells.length, cy / cells.length, '+' + gained,
                       combo >= 2 ? '#dc2626' : '#b45309');
      }
      if (combo >= 2) {
        renderer.showBanner('连锁 x' + combo, '#ef4444', 800);
      }
      if (specials > 0) audio.special();
    },

    onShuffle: function () {
      renderer.showBanner('无可消除，重新洗牌', '#0284c7', 1200);
    },

    onWin: function (info) {
      audio.win();
      // 解锁下一关
      if (info.level + 1 >= unlocked && unlocked < cfg.LEVELS.length) {
        unlocked = info.level + 2;
        store.set(cfg.STORE.UNLOCKED, unlocked);
      }
      setTimeout(function () { showWin(info); }, 650);
    },

    onLose: function (info) {
      audio.lose();
      setTimeout(function () { showLose(info); }, 650);
    }
  });

  /* ================= 遮罩面板 ================= */
  function showOverlay(html) {
    overlay.innerHTML = html;
    overlay.classList.add('show');
  }
  function hideOverlay() {
    overlay.classList.remove('show');
    overlay.innerHTML = '';
  }

  function panelBtn(label, action, cls) {
    return '<button type="button" class="btn ' + (cls || 'btn-primary') +
           '" data-action="' + action + '">' + label + '</button>';
  }

  function showStart() {
    showOverlay(
      '<div class="panel">' +
      '<h2>开心消消乐</h2>' +
      '<p>交换相邻小动物，凑成三个相同就消除！<br>步数用完前达到目标分即可过关。</p>' +
      '<p>当前进度：已解锁第 <b>' + unlocked + '</b> 关 / 共 ' + cfg.LEVELS.length + ' 关</p>' +
      '<div class="btn-row">' +
      panelBtn('开始游戏', 'play') +
      panelBtn('选择关卡', 'levels', 'btn-ghost') +
      '</div></div>'
    );
  }

  function showLevels() {
    var btns = '';
    for (var i = 0; i < cfg.LEVELS.length; i++) {
      var lockedCls = i < unlocked ? '' : ' locked';
      var label = i < unlocked ? (i + 1) : '🔒';
      btns += '<button type="button" class="level-btn' + lockedCls +
              '" data-level="' + i + '"' + (i < unlocked ? '' : ' disabled') +
              '>' + label + '</button>';
    }
    showOverlay(
      '<div class="panel">' +
      '<h2>选择关卡</h2>' +
      '<div class="level-grid">' + btns + '</div>' +
      '<div class="btn-row">' + panelBtn('返回', 'back', 'btn-ghost') + '</div>' +
      '</div>'
    );
  }

  function showWin(info) {
    var last = info.level >= cfg.LEVELS.length - 1;
    showOverlay(
      '<div class="panel">' +
      '<h2>' + (last ? '🎉 全部通关！' : '🎉 过关！') + '</h2>' +
      '<p>第 ' + (info.level + 1) + ' 关</p>' +
      '<div class="big-score">' + info.score + ' 分</div>' +
      '<div class="btn-row">' +
      (last ? panelBtn('再玩一次', 'replay') : panelBtn('下一关', 'next')) +
      panelBtn('重玩本关', 'replay', 'btn-ghost') +
      panelBtn('选关', 'levels', 'btn-ghost') +
      '</div></div>'
    );
  }

  function showLose(info) {
    var lv = cfg.LEVELS[info.level];
    showOverlay(
      '<div class="panel">' +
      '<h2>😢 步数用完</h2>' +
      '<p>第 ' + (info.level + 1) + ' 关目标 ' + lv.target + ' 分</p>' +
      '<div class="big-score">' + info.score + ' 分</div>' +
      '<p>差一点点，再来一次吧！</p>' +
      '<div class="btn-row">' +
      panelBtn('再试一次', 'replay') +
      panelBtn('选关', 'levels', 'btn-ghost') +
      '</div></div>'
    );
  }

  /* 面板按钮统一事件代理 */
  overlay.addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    audio.unlock();
    audio.click();

    var levelAttr = btn.getAttribute('data-level');
    if (levelAttr !== null) {
      currentLevel = +levelAttr;
      hideOverlay();
      game.start(currentLevel);
      return;
    }

    var action = btn.getAttribute('data-action');
    if (action === 'play') {
      currentLevel = unlocked - 1;
      hideOverlay();
      game.start(currentLevel);
    } else if (action === 'levels') {
      showLevels();
    } else if (action === 'back') {
      showStart();
    } else if (action === 'replay') {
      hideOverlay();
      game.start(currentLevel);
    } else if (action === 'next') {
      currentLevel = Math.min(currentLevel + 1, cfg.LEVELS.length - 1);
      hideOverlay();
      game.start(currentLevel);
    }
  });

  /* ================= 指针输入（点选 + 滑动） ================= */
  var pointerStart = null;   // {x, y, col, row, swiped}

  function eventCell(e) {
    var rect = canvas.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    return {
      x: x, y: y,
      col: Math.floor(x / rect.width * cfg.COLS),
      row: Math.floor(y / rect.height * cfg.ROWS),
      rectW: rect.width
    };
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    audio.unlock();
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    var c = eventCell(e);
    if (c.col < 0 || c.col >= cfg.COLS || c.row < 0 || c.row >= cfg.ROWS) return;
    pointerStart = { x: c.x, y: c.y, col: c.col, row: c.row, swiped: false, w: c.rectW };
  }, { passive: false });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointerStart || pointerStart.swiped) return;
    e.preventDefault();
    var c = eventCell(e);
    var cellPx = c.rectW / cfg.COLS;
    var dx = c.x - pointerStart.x;
    var dy = c.y - pointerStart.y;
    var threshold = cellPx * 0.35; // 滑动超过 1/3 格即触发交换

    if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
      pointerStart.swiped = true;
      var dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left')
                                            : (dy > 0 ? 'down' : 'up');
      game.swipe(pointerStart.col, pointerStart.row, dir);
    }
  }, { passive: false });

  canvas.addEventListener('pointerup', function (e) {
    if (!pointerStart) return;
    e.preventDefault();
    var wasSwipe = pointerStart.swiped;
    var col = pointerStart.col, row = pointerStart.row;
    pointerStart = null;

    if (!wasSwipe) {
      // 点选逻辑：选中 / 取消 / 与已选相邻格交换
      var result = game.tapCell(col, row);
      if (result === 'select') audio.select();
    }
  }, { passive: false });

  canvas.addEventListener('pointercancel', function () { pointerStart = null; });

  /* 阻止 iOS 双击缩放与长按菜单 */
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

  /* ================= 控制按钮 ================= */
  btnRestart.addEventListener('click', function () {
    audio.unlock(); audio.click();
    hideOverlay();
    game.start(currentLevel);
  });

  btnLevels.addEventListener('click', function () {
    audio.unlock(); audio.click();
    showLevels();
  });

  function refreshSoundBtn() {
    btnSound.textContent = audio.enabled ? '音效:开' : '音效:关';
    btnSound.setAttribute('aria-pressed', String(audio.enabled));
  }
  btnSound.addEventListener('click', function () {
    audio.unlock();
    audio.enabled = !audio.enabled;
    store.set(cfg.STORE.SOUND, audio.enabled);
    refreshSoundBtn();
    audio.click();
  });
  refreshSoundBtn();

  /* ================= 主循环 ================= */
  function resize() { renderer.resize(); }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () {
    setTimeout(resize, 120); // 等系统旋转动画结束再量尺寸
  });
  resize();

  var lastT = performance.now();
  function frame(now) {
    var dt = Math.min(now - lastT, 50);
    lastT = now;
    game.update(dt, now);
    renderer.draw(game, now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* 暴露实例，便于控制台调试与自动化测试 */
  Match3.game = game;

  /* 首次进入：显示开始面板，并先在后台摆好棋盘作预览 */
  game.start(currentLevel);
  showStart();
})();
