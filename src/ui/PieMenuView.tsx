/**
 * 右键饼菜单组件 —— 只负责几何与指针，内容与可用性全在 `pieMenu.ts`。
 *
 * 两层环：
 *   - **内圈**：7 格（有问题时 8 格）：结束/取消、绘图、工具、约束、尺寸、编辑、视图。
 *   - **外圈**：悬停的那个分组的孩子。到外圈才是一次真正的点击。
 *
 * 为什么两层而不是一圈放完：全放下来是 30+ 项，一圈的目标会缩到 10px 上下——比
 * 工具栏还慢，等于把"快"这个唯一的理由丢掉。两层让每次点击的目标都在 24px 以上。
 *
 * 位置由调用方给，且是**窗口坐标（clientX/clientY）**、渲染在 `document.body` 的
 * portal 里（见 `CanvasView`）：
 *
 *   - 画布宿主 `.canvas-host` 是 `overflow: hidden`——饼挂在它里面时，凡是超出宿主的
 *     部分都会被裁掉，靠近边角弹出就成了「显示不完整」。
 *   - 挂在 body 上还顺带免掉祖先的 z-index / 变换 / 滚动带来的坐标偏移。
 *
 * 定位用 `position: fixed` + 窗口坐标（`clientX/clientY`），贴边时按窗口尺寸等比缩小
 * （`pieScale`），与画布的缩放平移完全无关。
 *
 * **两套坐标系，别混**：`left/top` 是窗口坐标（元素左上角 = 光标 − half），而扇区几何
 * 画在 `viewBox` 的**内部坐标系**里（0,0 = 饼心，因为内容整体套了一层
 * `translate(half half)`）。所以几何函数一律用 `wedgePath` / `ringMid`（原点在圆心），
 * 绝不接受绝对坐标——曾经把 `at.x/at.y` 当圆心喂进去，圆心飞出 viewBox，整张饼错位。
 *
 * 禁用扇区一律画出并给 `title` 说明原因——直接隐藏会让人以为功能没了。
 */

import { useEffect, useMemo, useState } from 'react';
import type { Vec2 } from '../core/types';
import {
  pieOrigin,
  pieScale,
  ringBounds,
  ringMid,
  wedgePath,
  PIE_HALF,
  PIE_RING,
  type PieAction,
  type PieLeaf,
  type PieSector,
} from './pieMenu';

export interface PieMenuProps {
  /** 右键落点，**窗口坐标**（`clientX/clientY`）。 */
  at: Vec2;
  sectors: readonly PieSector[];
  onRun(action: PieAction): void;
  onClose(): void;
}

export default function PieMenu(props: PieMenuProps): React.ReactElement {
  const { at, sectors, onRun, onClose } = props;
  const [openId, setOpenId] = useState<string | null>(null);

  // **中心严格落在光标**；贴边时按可用空间等比缩小（方向/角度不变，只缩半径），
  // 所以既不会从光标处被推开，也不会在窗口边上缺一块。见 `pieScale` 的注释。
  //
  // 最后一道兜底：比例一旦不是一个正常的正数，就用 1（正常大小）。宁可用错大小，
  // 也不能把 NaN 喂给 `width` / `left` —— 那会让饼落在静态位置（多半在视口外），
  // 表现就是"右键唤不出菜单"。
  const rawK = pieScale(at, window.innerWidth, window.innerHeight);
  const k = Number.isFinite(rawK) && rawK > 0 ? rawK : 1;
  const half = PIE_HALF * k;
  const origin = pieOrigin(at, half);
  /** 缩放后的环半径。文字字号不缩，否则贴边时标签会小到看不清。 */
  const r = {
    inner: PIE_RING.inner * k,
    innerOut: PIE_RING.innerOut * k,
    outerIn: PIE_RING.outerIn * k,
    outerOut: PIE_RING.outerOut * k,
  };

  const open = useMemo(() => sectors.find((s) => s.id === openId) ?? null, [sectors, openId]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const leaf = (l: PieLeaf, index: number, count: number): React.ReactElement => {
    const [a0, a1] = ringBounds(index, count);
    const at_ = ringMid(a0, a1, (r.outerIn + r.outerOut) / 2);
    return (
      <g
        key={l.id}
        className={`pie-leaf${l.enabled ? '' : ' off'}`}
        onPointerDown={(ev) => {
          ev.stopPropagation();
          if (!l.enabled) return;
          onRun(l.action);
        }}
      >
        <title>{l.enabled ? l.label : `${l.label} —— ${l.reason ?? '当前不可用'}`}</title>
        <path d={wedgePath(r.outerIn, r.outerOut, a0, a1)} />
        <text x={at_.x} y={at_.y - 4} className="pie-glyph">
          {l.glyph}
        </text>
        <text x={at_.x} y={at_.y + 9} className="pie-text">
          {l.label}
        </text>
      </g>
    );
  };

  return (
    <svg
      className="pie-menu"
      width={half * 2}
      height={half * 2}
      viewBox={`0 0 ${half * 2} ${half * 2}`}
      style={{ left: origin.x, top: origin.y }}
      // 饼自己吞掉指针事件：右键落点下面的画布不该同时收到这一次操作。
      onPointerDown={(ev) => ev.stopPropagation()}
      onContextMenu={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      }}
    >
      {/* 唯一的坐标换算：把内部坐标系的原点搬到元素中心 = 光标处。
          里面所有几何（`wedgePath` / `ringMid`）都只认「原点在饼心」，拿不到绝对坐标。 */}
      <g transform={`translate(${half} ${half})`}>
        {/* 中心：当前指向的分组名（外圈展开时给出线索，不然会不知道外圈是什么） */}
        <circle cx={0} cy={0} r={r.inner - 6} className="pie-core" />
        <text x={0} y={4} className="pie-core-text">
          {open ? open.label : '右键'}
        </text>

        {sectors.map((s, i) => {
          const [a0, a1] = ringBounds(i, sectors.length);
          const at_ = ringMid(a0, a1, (r.inner + r.innerOut) / 2);
          const isOpen = open?.id === s.id;
          const hasChildren = (s.children?.length ?? 0) > 0;
          return (
            <g
              key={s.id}
              className={`pie-sector${s.enabled ? '' : ' off'}${isOpen ? ' open' : ''}${
                s.danger ? ' danger' : ''
              }`}
              onPointerEnter={() => setOpenId(hasChildren ? s.id : null)}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                if (!s.enabled) return;
                // 有孩子就先展开（第一次点=看，第二次点才落子）；叶子直接执行。
                if (hasChildren) {
                  setOpenId(isOpen ? null : s.id);
                  return;
              }
              if (s.action) onRun(s.action);
            }}
          >
            <title>
              {s.enabled
                ? (s.hint ?? s.label) + (hasChildren ? '（展开外圈）' : '')
                : `${s.label} —— ${s.reason ?? '当前不可用'}`}
            </title>
            <path d={wedgePath(r.inner, r.innerOut, a0, a1)} />
            <text x={at_.x} y={at_.y - 4} className="pie-glyph">
              {s.glyph}
            </text>
            <text x={at_.x} y={at_.y + 9} className="pie-text">
              {s.label}
            </text>
          </g>
        );
      })}

        {open?.children?.map((l, i) => leaf(l, i, open.children!.length))}
      </g>
    </svg>
  );
}
