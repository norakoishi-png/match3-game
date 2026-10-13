/* ============================================================
 * config.js - 全局配置与常量
 * 所有可调参数集中在此，便于调平衡与维护
 * ============================================================ */
(function (global) {
  'use strict';

  var Match3 = global.Match3 = global.Match3 || {};

  Match3.config = {
    /* 棋盘尺寸 */
    ROWS: 8,
    COLS: 8,

    /* 棋子种类：6 种卡通小动物（emoji 绘制 + 糖果色底板） */
    TYPES: [
      { id: 0, emoji: '🐤', name: '小鸡', color: '#f59e0b', bg: '#fef3c7' },
      { id: 1, emoji: '🐸', name: '青蛙', color: '#16a34a', bg: '#dcfce7' },
      { id: 2, emoji: '🦊', name: '狐狸', color: '#ea580c', bg: '#ffedd5' },
      { id: 3, emoji: '🐻', name: '小熊', color: '#7c3aed', bg: '#ede9fe' },
      { id: 4, emoji: '🐰', name: '兔子', color: '#db2777', bg: '#fce7f3' },
      { id: 5, emoji: '🐧', name: '企鹅', color: '#0284c7', bg: '#e0f2fe' }
    ],
    TYPE_COUNT: 6,
    COLOR_TYPE: -1,          // 彩色星星的类型标记（不参与普通匹配）

    /* 计分规则 */
    BASE_SCORE: 10,          // 每个被消除棋子基础分（乘以连击倍数）
    SPECIAL_BONUS: 120,      // 每生成一个特殊棋子的奖励分

    /* 动画时序（毫秒） */
    SWAP_MS: 190,            // 交换位移动画
    REMOVE_MS: 260,          // 消除缩放消失动画
    FALL_MS: 330,            // 下落/补充稳定等待
    SPAWN_MS: 200,           // 新棋子出现动画

    /* 关卡配置：target=目标分 moves=步数限制（共 10 关，难度递增） */
    LEVELS: [
      { target: 500,  moves: 18 },
      { target: 900,  moves: 20 },
      { target: 1500, moves: 20 },
      { target: 2200, moves: 22 },
      { target: 3000, moves: 22 },
      { target: 4000, moves: 24 },
      { target: 5000, moves: 24 },
      { target: 6200, moves: 25 },
      { target: 7600, moves: 25 },
      { target: 9000, moves: 26 }
    ],

    /* localStorage 键名 */
    STORE: {
      UNLOCKED: 'match3.unlockedLevel',  // 已解锁到的最高关卡（1 起）
      SOUND: 'match3.soundOn'            // 音效开关
    }
  };
})(window);
