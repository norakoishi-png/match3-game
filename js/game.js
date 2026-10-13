/* ============================================================
 * game.js - 三消核心游戏逻辑（纯逻辑层，不依赖 DOM）
 *
 * 架构要点：
 *  1. 棋盘权威数据：grid[row][col] 存 Piece 对象或 null。
 *  2. 逻辑与动画解耦：棋子的 row/col 是逻辑坐标（整数），
 *     gx/gy 是绘制坐标（浮点），update(dt) 中按指数平滑向
 *     逻辑位置逼近，渲染器只读 gx/gy/scale/alpha 即可画出
 *     丝滑的交换、下落、消除动画。
 *  3. 时序调度：消除连锁是"交换→检测→消除→下落→再检测"
 *     的串行流程，用轻量时间线 _after(ms, fn) 编排，
 *     无需 Promise/定时器嵌套，且随 rAF 统一驱动。
 *  4. 特殊棋子：row(整行)/col(整列)/bomb(3x3)/color(彩色星星)，
 *     消除命中特殊棋子会连锁触发其效果；彩色星星 type=-1
 *     不参与普通匹配，只能通过与任意棋子交换触发。
 * ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.Match3.config;
  var _pid = 1; // 棋子自增 id

  /* ---------- 棋子对象 ---------- */
  function Piece(type, row, col) {
    this.id = _pid++;
    this.type = type;          // 0~5 普通棋子，-1 彩色星星
    this.special = null;       // null | 'row' | 'col' | 'bomb' | 'color'
    this.row = row;
    this.col = col;
    this.gx = col;             // 绘制坐标（浮点，格为单位）
    this.gy = row;
    this.scale = 1;            // 缩放（消除时缩到 0）
    this.alpha = 1;
    this.removing = false;     // 正在播放消除动画
  }

  /* ---------- 游戏主体 ---------- */
  function Game(hooks) {
    this.hooks = hooks || {};
    this.state = 'idle';       // idle | ready(可操作) | busy(动画/结算中) | over
    this.level = 0;            // 当前关卡下标（0 起）
    this.target = 0;           // 目标分
    this.moves = 0;            // 剩余步数
    this.score = 0;
    this.grid = [];
    this.selected = null;      // 当前点选中的格子 {col,row}
    this._timeline = [];       // 时间线调度队列
  }

  Game.prototype = {

    /* ================= 生命周期 ================= */

    /**
     * 开始指定关卡
     * @param {number} levelIdx 关卡下标（0 起）
     */
    start: function (levelIdx) {
      this.level = Math.max(0, Math.min(levelIdx, cfg.LEVELS.length - 1));
      var lv = cfg.LEVELS[this.level];
      this.target = lv.target;
      this.moves = lv.moves;
      this.score = 0;
      this.selected = null;
      this._timeline = [];
      this._genBoard();
      this.state = 'ready';
      this._emitHud();
      this.hooks.onStart && this.hooks.onStart(this.level);
    },

    /* ================= 棋盘生成 ================= */

    /** 生成无现成三连、且保证存在可行步的初始棋盘 */
    _genBoard: function () {
      var tries = 0;
      do {
        this.grid = [];
        for (var r = 0; r < cfg.ROWS; r++) {
          this.grid.push([]); // 先入行再填子，_pickTypeFor 需读取本行左侧棋子
          for (var c = 0; c < cfg.COLS; c++) {
            this.grid[r].push(new Piece(this._pickTypeFor(r, c), r, c));
          }
        }
        tries++;
      } while (!this._hasPossibleMove() && tries < 100);
    },

    /** 随机取一个不会在 (r,c) 处立即形成三连的类型 */
    _pickTypeFor: function (r, c) {
      var banned = {};
      // 左侧两格相同则禁
      if (c >= 2 && this.grid[r][c - 1].type === this.grid[r][c - 2].type) {
        banned[this.grid[r][c - 1].type] = true;
      }
      // 上方两格相同则禁
      if (r >= 2 && this.grid[r - 1][c].type === this.grid[r - 2][c].type) {
        banned[this.grid[r - 1][c].type] = true;
      }
      var t;
      do { t = Math.floor(Math.random() * cfg.TYPE_COUNT); } while (banned[t]);
      return t;
    },

    /* ================= 输入 ================= */

    /**
     * 点选格子（tap-tap 操作）：第一次点选中，第二次点相邻格交换
     * @returns {string} 'select' | 'swap' | 'deselect' | 'ignore'
     */
    tapCell: function (col, row) {
      if (this.state !== 'ready') return 'ignore';
      var p = this.pieceAt(col, row);
      if (!p) return 'ignore';

      if (!this.selected) {
        this.selected = { col: col, row: row };
        return 'select';
      }
      if (this.selected.col === col && this.selected.row === row) {
        this.selected = null;
        return 'deselect';
      }
      var target = { col: col, row: row };
      if (this._adjacent(this.selected, target)) {
        var from = this.selected;
        this.selected = null;
        this.trySwap(from, target);
        return 'swap';
      }
      // 点了远处的格子：改选新格子
      this.selected = { col: col, row: row };
      return 'select';
    },

    /**
     * 滑动操作：从 (col,row) 向指定方向交换
     * @param {string} dir 'up'|'down'|'left'|'right'
     */
    swipe: function (col, row, dir) {
      if (this.state !== 'ready') return false;
      var d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
      if (!d) return false;
      this.selected = null;
      return this.trySwap({ col: col, row: row }, { col: col + d[0], row: row + d[1] });
    },

    /* ================= 交换与结算 ================= */

    /**
     * 尝试交换两个相邻格子，驱动后续消除连锁
     * @returns {boolean} 交换是否被接受
     */
    trySwap: function (a, b) {
      if (this.state !== 'ready') return false;
      if (!this._adjacent(a, b)) return false;
      var pa = this.pieceAt(a.col, a.row);
      var pb = this.pieceAt(b.col, b.row);
      if (!pa || !pb) return false;

      this.state = 'busy';
      var self = this;
      this._swapPieces(pa, pb);
      this.hooks.onSwap && this.hooks.onSwap();

      this._after(cfg.SWAP_MS + 40, function () {
        // 彩色星星参与交换：直接触发其效果（不要求三消）
        if (pa.special === 'color' || pb.special === 'color') {
          self._spendMove();
          self._triggerColorSwap(pa, pb);
          return;
        }

        var runs = self.findRuns();
        if (!runs.length) {
          // 未形成三消：交换回原位
          self._swapPieces(pa, pb);
          self.hooks.onBadSwap && self.hooks.onBadSwap();
          self._after(cfg.SWAP_MS + 40, function () { self._setReady(); });
          return;
        }

        self._spendMove();
        self._resolveLoop([pa, pb]);
      });
      return true;
    },

    /** 消除连锁主循环：检测→消除→下落→再检测，直到棋盘稳定 */
    _resolveLoop: function (preferCells) {
      var self = this;
      var combo = 0;

      (function loop() {
        var runs = self.findRuns();
        if (!runs.length) { self._finishTurn(); return; }

        combo++;
        self._applyRuns(runs, combo, preferCells);
        preferCells = null; // 特殊棋子生成位置优先权只在首消有效

        self._after(cfg.REMOVE_MS + 50, function () {
          self._collectRemoved();
          self._applyGravity();
          self.hooks.onFall && self.hooks.onFall();
          self._after(cfg.FALL_MS, loop);
        });
      })();
    },

    /**
     * 处理一轮匹配：计算特殊棋子生成、扩展消除集合、计分、播放消除动画
     * @param {Array} runs   findRuns() 的结果
     * @param {number} combo 当前连击数
     * @param {Array} prefer 本次交换的两个棋子（特殊棋子优先生成在其位置）
     */
    _applyRuns: function (runs, combo, prefer) {
      var creations = this._planCreations(runs, prefer);   // [{piece,kind}]
      var keepCells = {};                                   // 变身格不消除
      for (var i = 0; i < creations.length; i++) {
        keepCells[creations[i].piece.id] = true;
      }

      // 基础消除集合 = 所有 run 覆盖的格子（变身格除外）
      var removeMap = {};
      for (i = 0; i < runs.length; i++) {
        var cells = runs[i].cells;
        for (var j = 0; j < cells.length; j++) {
          var p = this.grid[cells[j].r][cells[j].c];
          if (p && !keepCells[p.id]) removeMap[p.id] = p;
        }
      }

      // 连锁扩展：被消除的特殊棋子触发自身效果（可继续引爆其他特殊棋子）
      var queue = [];
      for (var id in removeMap) queue.push(removeMap[id]);
      var expanded = {};
      while (queue.length) {
        var sp = queue.pop();
        if (!sp.special || expanded[sp.id]) continue;
        expanded[sp.id] = true;
        var blast = this._blastCells(sp);
        for (i = 0; i < blast.length; i++) {
          var bp = this.grid[blast[i].r] && this.grid[blast[i].r][blast[i].c];
          if (bp && !removeMap[bp.id] && !keepCells[bp.id] && !bp.removing) {
            removeMap[bp.id] = bp;
            queue.push(bp);
          }
        }
      }

      // 计分：棋子数 x 基础分 x 连击倍数 + 特殊棋子生成奖励
      var count = 0;
      for (id in removeMap) count++;
      var gained = count * cfg.BASE_SCORE * combo + creations.length * cfg.SPECIAL_BONUS;
      this.score += gained;

      // 播放消除动画
      var removedInfo = [];
      for (id in removeMap) {
        var rp = removeMap[id];
        rp.removing = true;
        removedInfo.push({ col: rp.col, row: rp.row, type: rp.type, special: rp.special });
      }

      // 变身特殊棋子（原格子保留，短暂放大提示）
      for (i = 0; i < creations.length; i++) {
        var cr = creations[i];
        cr.piece.special = cr.kind;
        if (cr.kind === 'color') cr.piece.type = cfg.COLOR_TYPE;
        cr.piece.scale = 1.45; // update 中会平滑回到 1
      }

      this.hooks.onMatch && this.hooks.onMatch(removedInfo, gained, combo, creations.length);
      this._emitHud();
    },

    /**
     * 规划本轮要生成的特殊棋子
     * 规则：5 连→彩色星星；4 连→直线（方向与连线垂直）；L/T 交叉→炸弹
     */
    _planCreations: function (runs, prefer) {
      var atCell = {};   // 'c,r' -> kind
      var cross = {};    // 'c,r' -> {h:bool,v:bool}

      var i, j, key;
      for (i = 0; i < runs.length; i++) {
        var run = runs[i];
        for (j = 0; j < run.cells.length; j++) {
          key = run.cells[j].c + ',' + run.cells[j].r;
          cross[key] = cross[key] || {};
          cross[key][run.dir] = true;
        }
      }

      // L/T 交叉格 → 炸弹（优先级最高）
      for (key in cross) {
        if (cross[key].h && cross[key].v) atCell[key] = 'bomb';
      }

      // 长连 → 直线 / 彩色星星
      for (i = 0; i < runs.length; i++) {
        var r2 = runs[i];
        if (r2.cells.length >= 5) {
          atCell[this._pickCreationCell(r2, prefer)] = 'color';
        } else if (r2.cells.length === 4) {
          var k2 = this._pickCreationCell(r2, prefer);
          if (!atCell[k2]) atCell[k2] = r2.dir === 'h' ? 'row' : 'col';
        }
      }

      var list = [];
      for (key in atCell) {
        var parts = key.split(',');
        var piece = this.grid[+parts[1]][+parts[0]];
        if (piece) list.push({ piece: piece, kind: atCell[key] });
      }
      return list;
    },

    /** 选择特殊棋子生成位置：优先本次交换的棋子，其次连线中点 */
    _pickCreationCell: function (run, prefer) {
      if (prefer) {
        for (var i = 0; i < prefer.length; i++) {
          for (var j = 0; j < run.cells.length; j++) {
            if (run.cells[j].c === prefer[i].col && run.cells[j].r === prefer[i].row) {
              return prefer[i].col + ',' + prefer[i].row;
            }
          }
        }
      }
      var mid = run.cells[Math.floor(run.cells.length / 2)];
      return mid.c + ',' + mid.r;
    },

    /** 特殊棋子的爆炸范围 */
    _blastCells: function (p) {
      var cells = [];
      var r, c;
      if (p.special === 'row') {
        for (c = 0; c < cfg.COLS; c++) cells.push({ c: c, r: p.row });
      } else if (p.special === 'col') {
        for (r = 0; r < cfg.ROWS; r++) cells.push({ c: p.col, r: r });
      } else if (p.special === 'bomb') {
        for (r = p.row - 1; r <= p.row + 1; r++) {
          for (c = p.col - 1; c <= p.col + 1; c++) {
            if (r >= 0 && r < cfg.ROWS && c >= 0 && c < cfg.COLS) cells.push({ c: c, r: r });
          }
        }
      }
      return cells;
    },

    /** 彩色星星交换触发：消除对方类型全部棋子；星星+星星=清屏 */
    _triggerColorSwap: function (pa, pb) {
      var self = this;
      var bomb = pa.special === 'color' ? pa : pb;
      var other = bomb === pa ? pb : pa;
      var removeMap = {};
      removeMap[bomb.id] = bomb;

      var r, c, p;
      if (other.special === 'color') {
        // 双星合璧：清空全场
        for (r = 0; r < cfg.ROWS; r++) {
          for (c = 0; c < cfg.COLS; c++) {
            p = this.grid[r][c];
            if (p) removeMap[p.id] = p;
          }
        }
      } else {
        var t = other.type;
        removeMap[other.id] = other;
        for (r = 0; r < cfg.ROWS; r++) {
          for (c = 0; c < cfg.COLS; c++) {
            p = this.grid[r][c];
            if (p && p.type === t) removeMap[p.id] = p;
          }
        }
      }

      var info = [];
      var count = 0;
      for (var id in removeMap) {
        var rp = removeMap[id];
        rp.removing = true;
        count++;
        info.push({ col: rp.col, row: rp.row, type: rp.type, special: rp.special });
      }
      var gained = count * cfg.BASE_SCORE;
      this.score += gained;
      this.hooks.onMatch && this.hooks.onMatch(info, gained, 1, 0);
      this._emitHud();

      this._after(cfg.REMOVE_MS + 50, function () {
        self._collectRemoved();
        self._applyGravity();
        self.hooks.onFall && self.hooks.onFall();
        self._after(cfg.FALL_MS, function () { self._resolveLoop(null); });
      });
    },

    /** 结算完毕的棋子从棋盘移除 */
    _collectRemoved: function () {
      for (var r = 0; r < cfg.ROWS; r++) {
        for (var c = 0; c < cfg.COLS; c++) {
          var p = this.grid[r][c];
          if (p && p.removing) this.grid[r][c] = null;
        }
      }
    },

    /** 重力下落 + 顶部补充新棋子 */
    _applyGravity: function () {
      for (var c = 0; c < cfg.COLS; c++) {
        // 从底向上压实
        var write = cfg.ROWS - 1;
        for (var r = cfg.ROWS - 1; r >= 0; r--) {
          var p = this.grid[r][c];
          if (p) {
            if (write !== r) {
              this.grid[write][c] = p;
              this.grid[r][c] = null;
              p.row = write;
            }
            write--;
          }
        }
        // 空位由顶部新棋子补齐（gy 从棋盘上方飞入）
        var spawnIdx = 0;
        for (r = write; r >= 0; r--) {
          var np = new Piece(Math.floor(Math.random() * cfg.TYPE_COUNT), r, c);
          np.gy = -(spawnIdx + 1);        // 起始位置在棋盘上方
          np.scale = 1;
          spawnIdx++;
          this.grid[r][c] = np;
        }
      }
    },

    /** 一轮连锁结束：判定过关/失败/死局 */
    _finishTurn: function () {
      this._emitHud();

      if (this.score >= this.target) {
        this.state = 'over';
        this.hooks.onWin && this.hooks.onWin({ level: this.level, score: this.score });
        return;
      }
      if (this.moves <= 0) {
        this.state = 'over';
        this.hooks.onLose && this.hooks.onLose({ level: this.level, score: this.score });
        return;
      }
      if (!this._hasPossibleMove()) {
        // 死局：洗牌重来（不扣步数）
        this.hooks.onShuffle && this.hooks.onShuffle();
        this._shuffleBoard();
      }
      this._setReady();
    },

    _setReady: function () {
      if (this.state === 'busy') this.state = 'ready';
    },

    _spendMove: function () {
      this.moves = Math.max(0, this.moves - 1);
      this._emitHud();
    },

    /* ================= 匹配检测 ================= */

    /**
     * 扫描全盘三连及以上
     * @returns {Array} [{dir:'h'|'v', cells:[{r,c}...]}...]
     */
    findRuns: function () {
      var runs = [];
      var r, c, p, len;

      // 横向
      for (r = 0; r < cfg.ROWS; r++) {
        c = 0;
        while (c < cfg.COLS) {
          p = this.grid[r][c];
          if (!this._matchable(p)) { c++; continue; }
          len = 1;
          while (c + len < cfg.COLS) {
            var q = this.grid[r][c + len];
            if (!this._matchable(q) || q.type !== p.type) break;
            len++;
          }
          if (len >= 3) {
            var cells = [];
            for (var k = 0; k < len; k++) cells.push({ r: r, c: c + k });
            runs.push({ dir: 'h', cells: cells });
          }
          c += len;
        }
      }

      // 纵向
      for (c = 0; c < cfg.COLS; c++) {
        r = 0;
        while (r < cfg.ROWS) {
          p = this.grid[r][c];
          if (!this._matchable(p)) { r++; continue; }
          len = 1;
          while (r + len < cfg.ROWS) {
            var q2 = this.grid[r + len][c];
            if (!this._matchable(q2) || q2.type !== p.type) break;
            len++;
          }
          if (len >= 3) {
            var cells2 = [];
            for (var k2 = 0; k2 < len; k2++) cells2.push({ r: r + k2, c: c });
            runs.push({ dir: 'v', cells: cells2 });
          }
          r += len;
        }
      }
      return runs;
    },

    /** 该棋子是否可参与普通三消（彩色星星与消除中棋子除外） */
    _matchable: function (p) {
      return p && !p.removing && p.type >= 0;
    },

    /**
     * 棋盘上是否还存在可行交换（用于死局检测）
     * 对每个格子尝试与右、下邻居假交换，看能否形成三连
     */
    _hasPossibleMove: function () {
      for (var r = 0; r < cfg.ROWS; r++) {
        for (var c = 0; c < cfg.COLS; c++) {
          var p = this.grid[r][c];
          if (!p) continue;
          // 彩色星星本身就是可行步（与任意相邻棋子交换都能触发）
          if (p.type < 0) return true;
          var neighbors = [[1, 0], [0, 1]];
          for (var i = 0; i < neighbors.length; i++) {
            var nc = c + neighbors[i][0], nr = r + neighbors[i][1];
            if (nc >= cfg.COLS || nr >= cfg.ROWS) continue;
            var q = this.grid[nr][nc];
            if (!q) continue;
            if (q.type < 0) return true; // 邻居是彩色星星
            // 假交换类型后局部检测
            var t = p.type; p.type = q.type; q.type = t;
            var ok = this._runThrough(c, r) || this._runThrough(nc, nr);
            t = p.type; p.type = q.type; q.type = t; // 还原
            if (ok) return true;
          }
        }
      }
      return false;
    },

    /** 检测经过 (c,r) 的横向或纵向三连（用于可行步局部判定） */
    _runThrough: function (c, r) {
      var p = this.grid[r][c];
      if (!p || p.type < 0) return false;
      var t = p.type, len, i;

      // 横向连续同类数
      len = 1;
      for (i = c - 1; i >= 0 && this.grid[r][i] && this.grid[r][i].type === t; i--) len++;
      for (i = c + 1; i < cfg.COLS && this.grid[r][i] && this.grid[r][i].type === t; i++) len++;
      if (len >= 3) return true;

      // 纵向
      len = 1;
      for (i = r - 1; i >= 0 && this.grid[i][c] && this.grid[i][c].type === t; i--) len++;
      for (i = r + 1; i < cfg.ROWS && this.grid[i][c] && this.grid[i][c].type === t; i++) len++;
      return len >= 3;
    },

    /** 死局时重排棋子类型（保持位置与特殊棋子不变），并播放缩放动画 */
    _shuffleBoard: function () {
      var tries = 0;
      var self = this;
      do {
        // 收集普通棋子类型，洗牌后回填
        var types = [];
        var slots = [];
        for (var r = 0; r < cfg.ROWS; r++) {
          for (var c = 0; c < cfg.COLS; c++) {
            var p = this.grid[r][c];
            if (p && p.type >= 0) { types.push(p.type); slots.push(p); }
          }
        }
        for (var i = types.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = types[i]; types[i] = types[j]; types[j] = tmp;
        }
        for (i = 0; i < slots.length; i++) {
          slots[i].type = types[i];
          slots[i].scale = 0.01; // 洗牌动画：缩没再弹回
        }
        tries++;
        // 保证洗牌后无现成三连且有可行步，否则重洗
      } while ((this.findRuns().length > 0 || !this._hasPossibleMove()) && tries < 80);

      this._after(cfg.SPAWN_MS + 120, function () { /* 动画缓冲 */ });
    },

    /* ================= 主循环（动画驱动） ================= */

    /**
     * 每渲染帧调用：推进时间线 + 平滑棋子动画
     * @param {number} dt  距上一帧毫秒数
     * @param {number} now performance.now()
     */
    update: function (dt, now) {
      // 执行到期的调度任务
      for (var i = this._timeline.length - 1; i >= 0; i--) {
        if (now >= this._timeline[i].at) {
          var fn = this._timeline[i].fn;
          this._timeline.splice(i, 1);
          fn.call(this);
        }
      }

      // 棋子动画：位置指数平滑 + 缩放/透明度
      var kPos = Math.min(1, dt / 95);    // 位置平滑系数（交换/下落）
      var kScale = Math.min(1, dt / 130); // 缩放平滑系数
      for (var r = 0; r < cfg.ROWS; r++) {
        var rowArr = this.grid[r];
        if (!rowArr) continue; // 棋盘未初始化（idle 态）时跳过
        for (var c = 0; c < cfg.COLS; c++) {
          var p = rowArr[c];
          if (!p) continue;

          p.gx += (p.col - p.gx) * kPos;
          p.gy += (p.row - p.gy) * kPos;
          if (Math.abs(p.col - p.gx) < 0.02) p.gx = p.col;
          if (Math.abs(p.row - p.gy) < 0.02) p.gy = p.row;

          var targetScale = p.removing ? 0 : 1;
          p.scale += (targetScale - p.scale) * kScale;
          if (p.removing) {
            p.alpha = Math.max(0, p.scale);
          } else {
            p.alpha = Math.min(1, p.scale + 0.1);
            if (p.scale > 1.02 && targetScale === 1) {
              // 特殊棋子生成时的放大，缓慢回落
              p.scale += (1 - p.scale) * Math.min(1, dt / 200);
            }
          }
        }
      }
    },

    /* ================= 工具 ================= */

    pieceAt: function (col, row) {
      if (row < 0 || row >= cfg.ROWS || col < 0 || col >= cfg.COLS) return null;
      return this.grid[row][col];
    },

    _adjacent: function (a, b) {
      return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
    },

    /** 交换两个棋子的逻辑位置（grid 与 row/col 同步更新，gx/gy 平滑跟上） */
    _swapPieces: function (pa, pb) {
      var rc = pa.row, cc = pa.col;
      pa.row = pb.row; pa.col = pb.col;
      pb.row = rc; pb.col = cc;
      this.grid[pa.row][pa.col] = pa;
      this.grid[pb.row][pb.col] = pb;
    },

    /** 延迟调度：在当前帧时间上排队一个任务 */
    _after: function (ms, fn) {
      this._timeline.push({ at: performance.now() + ms, fn: fn });
    },

    _emitHud: function () {
      this.hooks.onHud && this.hooks.onHud({
        level: this.level + 1,
        target: this.target,
        score: this.score,
        moves: this.moves
      });
    }
  };

  global.Match3 = global.Match3 || {};
  global.Match3.Game = Game;
})(window);
