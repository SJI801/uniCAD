/**
 * The datum panel: which plane sketches land on, and where the reference
 * coordinate systems are.
 *
 * It sits in the left column beside 图层 / 属性 because a datum plane plays the
 * same role for 3D that a layer plays for 2D — it is the thing new geometry is
 * *put on*, and you reach for it constantly. Visibility is toggled for the 3D
 * view; the plane's name is the button that makes it active, because that is the
 * action you actually came here for.
 */

import { useState } from 'react';
import { useEditor } from '../state/editorStore';

/** The three planes every document starts with — the only creation sources. */
const BASE_IDS: readonly string[] = ['xy', 'yz', 'zx'];

export default function DatumPanel(): React.ReactElement {
  const doc = useEditor((s) => s.doc);
  const setActivePlane = useEditor((s) => s.setActivePlane);
  const setPlaneVisible = useEditor((s) => s.setPlaneVisible);
  const setFrameVisible = useEditor((s) => s.setFrameVisible);
  const addFrameOnActivePlane = useEditor((s) => s.addFrameOnActivePlane);
  const deleteFrame = useEditor((s) => s.deleteFrame);
  const addOffsetPlane = useEditor((s) => s.addOffsetPlane);
  const deletePlane = useEditor((s) => s.deletePlane);
  // The base plane lives in the store, not here: clicking a plane in the 3D
  // viewport selects the same thing, and both surfaces have to agree.
  const datumBase = useEditor((s) => s.datumBase);
  const setDatumBase = useEditor((s) => s.setDatumBase);
  const view3d = useEditor((s) => s.view3d);
  const setView3d = useEditor((s) => s.setView3d);

  const [offsetText, setOffsetText] = useState('20');

  const offset = Number(offsetText);
  const canCreate = Number.isFinite(offset) && offset !== 0;
  const create = (): void => {
    if (!canCreate) return;
    addOffsetPlane(datumBase, offset);
  };

  return (
    <div className="panel-body">
      <section className="panel-section">
        <h3>基准面</h3>
        <p className="panel-hint">
          新图元画在<strong>活动基准面</strong>上；拉伸沿它的法线。2D 视图只显示活动面上的图元。
        </p>
        <ul className="entity-list datum-list">
          {doc.planes.map((p) => {
            const active = p.id === doc.activePlane;
            return (
              <li key={p.id} className={active ? 'datum-active' : ''}>
                <button
                  className={`dot-btn ${p.visible ? 'on' : ''}`}
                  onClick={() => setPlaneVisible(p.id, !p.visible)}
                  title={p.visible ? '在 3D 中隐藏' : '在 3D 中显示'}
                  aria-label={p.visible ? '隐藏基准面' : '显示基准面'}
                />
                <button
                  className="datum-name"
                  onClick={() => setActivePlane(p.id)}
                  title="设为活动草图面"
                >
                  {p.name}
                </button>
                {BASE_IDS.includes(p.id) ? (
                  <span className="datum-badge">{active ? '活动' : ''}</span>
                ) : (
                  <>
                    {active ? <span className="datum-badge">活动</span> : null}
                    <button
                      className="link-btn"
                      onClick={() => deletePlane(p.id)}
                      title="删除这个基准面（面上有图元时会被拒绝）"
                    >
                      删除
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <button className="wide-btn" onClick={() => setView3d(!view3d)}>
          {view3d ? '回到 2D 草图' : '切到 3D 查看'}
        </button>
      </section>

      <section className="panel-section">
        <h3>新建基准面</h3>
        <p className="panel-hint">选一个坐标平面，沿它的法线偏移一段距离。</p>
        <div className="datum-row">
          {doc.planes
            .filter((p) => BASE_IDS.includes(p.id))
            .map((p) => (
              <button
                key={p.id}
                className={`chip ${datumBase === p.id ? 'active' : ''}`}
                onClick={() => setDatumBase(p.id)}
                title={`以 ${p.name} 为基准（也可在 3D 视图里点选）`}
              >
                {p.id.toUpperCase()}
              </button>
            ))}
        </div>
        <div className="datum-row">
          <input
            className="datum-input"
            value={offsetText}
            onChange={(e) => setOffsetText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
            }}
            inputMode="decimal"
            placeholder="偏移距离"
            aria-label="偏移距离"
          />
          <button className="wide-btn slim" onClick={create} disabled={!canCreate}>
            创建
          </button>
        </div>
      </section>

      <section className="panel-section">
        <h3>参考坐标系</h3>
        <ul className="entity-list datum-list">
          {doc.frames.map((f) => (
            <li key={f.id}>
              <button
                className={`dot-btn ${f.visible ? 'on' : ''}`}
                onClick={() => setFrameVisible(f.id, !f.visible)}
                title={f.visible ? '在 3D 中隐藏三脚标' : '在 3D 中显示三脚标'}
                aria-label={f.visible ? '隐藏三脚标' : '显示三脚标'}
              />
              <span className="datum-name static">{f.name}</span>
              {f.id === 'world' ? (
                <span className="datum-badge">默认</span>
              ) : (
                <button className="link-btn" onClick={() => deleteFrame(f.id)}>
                  删除
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          className="wide-btn"
          onClick={() => addFrameOnActivePlane()}
          title="在当前活动基准面上新建一个坐标系（原点 + 两轴）"
        >
          按活动面新建坐标系
        </button>
      </section>

      <p className="panel-hint">
        坐标系用于参考与摆放基准；一期不会改变图元的绝对坐标。
      </p>
    </div>
  );
}
