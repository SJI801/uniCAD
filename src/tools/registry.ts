/**
 * Tool registry: the metadata the ribbon, the command line and the keyboard
 * shortcut layer all share.
 */

export interface ToolSpec {
  id: string;
  name: string;
  /** Command alias typed into the command line. */
  alias: string;
  glyph: string;
  hint: string;
}

export const TOOL_SPECS: ToolSpec[] = [
  { id: 'select', name: '选择', alias: 'SEL', glyph: '⬚', hint: '选择对象、移动、框选' },
  { id: 'line', name: '直线', alias: 'L', glyph: '╱', hint: '两点绘制直线，可连续绘制' },
  { id: 'polyline', name: '多段线', alias: 'PL', glyph: '⟋', hint: '连续折线，右键或 C 闭合' },
  { id: 'rect', name: '矩形', alias: 'REC', glyph: '▭', hint: '按对角两点绘制矩形' },
  { id: 'circle', name: '圆', alias: 'C', glyph: '◯', hint: '圆心 + 半径（也可直接输入半径）' },
  { id: 'arc', name: '圆弧', alias: 'A', glyph: '◜', hint: '三点绘制圆弧' },
  { id: 'ellipse', name: '椭圆', alias: 'EL', glyph: '⬭', hint: '中心 + 长短半轴' },
  { id: 'trim', name: '修剪', alias: 'TR', glyph: '✂', hint: '点击被其它图元夹住的那一段，剪掉它' },
  { id: 'offset', name: '偏置', alias: 'O', glyph: '⊂', hint: '按给定距离生成平行曲线（可输入确切距离）' },
  { id: 'extrude', name: '拉伸', alias: 'X', glyph: '⬒', hint: '把封闭草图拉成 3D 实体：选轮廓 → 输入高度' },
  { id: 'revolve', name: '旋转', alias: 'REV', glyph: '◑', hint: '把封闭草图绕一根直线车削：选轮廓 → 选轴 → 输入角度（度）' },
  { id: 'hole', name: '打孔', alias: 'H', glyph: '⊚', hint: '在 3D 视图里点一个实体表面打孔（参数在特征树上改）' },
  { id: 'measure', name: '测量', alias: 'DI', glyph: '⇔', hint: '测量两点距离与角度' },
];

export const ALIAS_TO_TOOL = new Map<string, string>(
  TOOL_SPECS.flatMap((t) => [
    [t.alias.toUpperCase(), t.id],
    [t.id.toUpperCase(), t.id],
  ]),
);
