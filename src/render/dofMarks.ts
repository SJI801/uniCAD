/**
 * 欠约束方向标记 —— 「这条曲线还能往哪动」。
 *
 * 0.3 的自由度报告有两个问题要回答，界面各答一半：状态栏的 chip 答「还差几个」
 * （数字 + 完全定义 + 冲突），这里答「差在哪」。选中一个图元时，在它身上画出它
 * 仍然自由的**可读动作**：
 *
 *   ↔ / ↕  十字双向箭头 = 还能平移（两根都在 = 任意方向都能挪）
 *   转              = 还能转（绕某个命名点或质心）
 *   尺寸             = 尺寸未定（半径 / 长度 / 半轴还能改）
 *
 * 为什么转动/尺寸用**汉字**而不是 ⟳ / ⤢：画布上的标注走的是项目那套等宽字体栈
 * （见 `constraintMarks.ts` 开头同一条理由），`⟳`(U+27F3) 与 `⤢` 不在其中，落到
 * 字体回退就可能变成看不见的豆腐块——「标了但看不见」比不标更糟。这两个动作没有
 * 像 ⊙ ∈ ⊥ 那样人人认得的单字符符号，就用最短的中文：**一定渲染得出来**。
 *
 * 为什么不直接画零空间基向量：基是求解器任意选取的一组组合，既不可读也不稳定
 * （同一张图换一次求解顺序，箭头就换一个样子）。「能不能平移/转/改尺寸」才是
 * 用户的问题，而且它**与基无关**——内核用固定的一组动作用 `J·m ≈ 0` 逐个测。
 *
 * 只画**选中**的图元：和约束徽章、解空间引导同一条规矩——画布上的约束类记号是
 * 你正在弄的那件事的提示，不是全图装饰。数量也有上限，同 `MAX_BADGES` 的理由。
 */

import type { Entity, EntityId, Vec2 } from '../core/types';
import { DOF_MODE } from '../core/constraints';
import type { DimContext, DimLabel } from './dims';
import type { OverlaySegment } from './overlay';
import { UI_COLORS } from './style';

/** 箭头总长（屏幕像素）——交互标记一律按屏幕给，不随缩放变。 */
const ARROW = 24;
const BARB = 5;
/** ⟳ / ⤢ 离锚点多远，免得压在平移箭头上。 */
const LABEL_GAP = 15;
const MAX_MARKED = 40;

/** 标记挂在哪个点上：能代表这个图元「在哪」的那个点。 */
function anchorOf(e: Entity): Vec2 | null {
  switch (e.type) {
    case 'line':
      return { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    case 'circle':
    case 'arc':
    case 'ellipse':
      return e.center;
    case 'polyline': {
      if (e.points.length === 0) return null;
      const s = e.points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
      return { x: s.x / e.points.length, y: s.y / e.points.length };
    }
  }
}

export interface DofMarks {
  segments: OverlaySegment[];
  labels: DimLabel[];
}

const EMPTY: DofMarks = { segments: [], labels: [] };

/**
 * 画出每个选中图元**还剩的动作**。
 *
 * `entities` 与 `visible` 都是活动基准面上可见的图元（调用方已经过滤过）；
 * `visible` 再挡一道，是为了让隐藏图层上的图元不会出现「标了方向却看不见它」。
 */
export function dofMarkers(
  entities: readonly Entity[],
  selected: ReadonlySet<EntityId>,
  modes: ReadonlyMap<EntityId, number>,
  visible: readonly Entity[],
  ctx: DimContext,
): DofMarks {
  if (selected.size === 0 || modes.size === 0) return EMPTY;
  if (!(ctx.scale > 0) || !Number.isFinite(ctx.scale)) return EMPTY;

  const onLayer = new Set(visible.map((e) => e.id));
  const segments: OverlaySegment[] = [];
  const labels: DimLabel[] = [];
  let marked = 0;

  for (const e of entities) {
    if (marked >= MAX_MARKED) break;
    if (!selected.has(e.id) || !onLayer.has(e.id)) continue;
    const flags = modes.get(e.id) ?? 0;
    if (flags === 0) continue;
    const at = anchorOf(e);
    if (!at) continue;
    marked += 1;

    // 模型单位下的箭头尺寸：屏幕像素 × scale，和尺寸线同一套换算。
    const len = ARROW * ctx.scale;
    const barb = BARB * ctx.scale;
    const seg = (a: Vec2, b: Vec2): OverlaySegment => ({
      a,
      b,
      color: UI_COLORS.dof,
      width: 1.4,
      dash: null,
    });
    /** 一根**双向**箭头：表示这一轴两边都能去。 */
    const doubleArrow = (axis: 'x' | 'y'): void => {
      const u = axis === 'x' ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const n = axis === 'x' ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const p1 = { x: at.x - u.x * len, y: at.y - u.y * len };
      const p2 = { x: at.x + u.x * len, y: at.y + u.y * len };
      segments.push(seg(p1, p2));
      // 两端的箭羽：各两笔，斜着退回轴线上。
      for (const [tip, dir] of [
        [p1, 1],
        [p2, -1],
      ] as const) {
        for (const side of [1, -1]) {
          segments.push(
            seg(tip, {
              x: tip.x + u.x * dir * barb + n.x * side * barb,
              y: tip.y + u.y * dir * barb + n.y * side * barb,
            }),
          );
        }
      }
    };

    if (flags & DOF_MODE.tx) doubleArrow('x');
    if (flags & DOF_MODE.ty) doubleArrow('y');

    // 转动 / 尺寸用文字（画布上的字形层已经是 DOM，11px 比线段拼出来的符号清楚，
    // 而且汉字一定渲染得出来）。两个都自由时上下排开，不互相压。
    const s = ctx.screenOf(at);
    if (flags & DOF_MODE.rot) {
      labels.push({
        x: s.x + LABEL_GAP,
        y: s.y - LABEL_GAP,
        text: '转',
        kind: 'dof',
        title: '转动方向未约束：这个图元还能绕某个点转（加「水平/竖直/角度」就能定住）',
      });
    }
    if (flags & DOF_MODE.size) {
      labels.push({
        x: s.x + LABEL_GAP,
        y: s.y + (flags & DOF_MODE.rot ? LABEL_GAP : -LABEL_GAP),
        text: '尺寸',
        kind: 'dof',
        title: '尺寸未定：半径 / 长度 / 半轴还能改（写一个尺寸约束即可定住）',
      });
    }
  }

  return { segments, labels };
}
