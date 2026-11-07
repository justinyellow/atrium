import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, BarChartHorizontal, LineChart, AreaChart, PieChart, Hash } from 'lucide-react';
import { post } from '../lib/api';
import type { ChartConfig, Database, DbView, Prop } from '../lib/types';
import { formatNumber, updateView } from './dbutil';
import type { ViewProps } from './shared';

export interface AggResult {
  kind: ChartConfig['kind'];
  series: { key: string; label: string; color?: string }[];
  points: { key: string; label: string; color?: string; values: Record<string, number>; total: number }[];
  total: number;
  rows: number;
  fn: string;
  prop?: string;
}

export const CHART_KINDS: { kind: ChartConfig['kind']; label: string; icon: any }[] = [
  { kind: 'column', label: 'Vertical bar', icon: BarChart3 },
  { kind: 'bar', label: 'Horizontal bar', icon: BarChartHorizontal },
  { kind: 'line', label: 'Line', icon: LineChart },
  { kind: 'area', label: 'Area', icon: AreaChart },
  { kind: 'donut', label: 'Donut', icon: PieChart },
  { kind: 'number', label: 'Number', icon: Hash },
];
const X_TYPES = ['select', 'status', 'multi_select', 'person', 'created_by', 'last_edited_by', 'date', 'created_time', 'last_edited_time', 'checkbox', 'text', 'title', 'url', 'email', 'phone', 'number', 'place', 'verification'];
const VALUE_TYPES = ['number', 'formula', 'rollup', 'unique_id'];
const FN_LABEL: Record<string, string> = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', median: 'Median' };

export function defaultChart(schema: Prop[]): ChartConfig {
  const x = schema.find((p) => p.type === 'status') ?? schema.find((p) => p.type === 'select') ?? schema.find((p) => p.type === 'date');
  return { kind: 'column', ...(x ? { xProp: x.id } : {}), aggregate: { fn: 'count' }, showLegend: true };
}

/** Aggregated chart data; lives under the ['dbq', dbId] prefix so live database events refresh it. */
export function useAggregate(dbId: string, viewId: string | undefined, chart: ChartConfig | undefined, filter: any, search = '') {
  return useQuery({
    queryKey: ['dbq', dbId, 'agg', viewId ?? '', JSON.stringify(chart ?? null), JSON.stringify(filter ?? null), search],
    queryFn: () => post<AggResult>(`/databases/${dbId}/aggregate`, { chart, filter: filter ?? undefined, search: search || undefined }),
    enabled: !!chart,
    placeholderData: (prev) => prev,
  });
}

/** Entity colour: option-backed categories keep their option colour; everything else takes the fixed categorical order. */
function colorFor(i: number, optionColor?: string) {
  if (optionColor && optionColor !== 'default') return `var(--c-${optionColor})`;
  if (optionColor === 'default') return 'var(--c-gray)';
  return `var(--viz-${(i % 8) + 1})`;
}

function fmt(v: number, prop?: Prop) {
  if (prop?.type === 'number' && prop.number_format) return formatNumber(Math.round(v * 100) / 100, prop.number_format);
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100);
}

/** ~4 evenly spaced "nice" ticks (1/2/5 × 10^n steps, whole numbers for whole-number data). */
function niceTicks(v: number, integer: boolean) {
  if (v <= 0) return [0, 1];
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  let step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  if (integer) step = Math.max(1, Math.round(step));
  const out = [0];
  while (out[out.length - 1] < v - 1e-9) out.push(Math.round((out[out.length - 1] + step) * 1e9) / 1e9);
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    setW(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Renders an aggregate result. Pure SVG + an HTML tooltip; a visually-hidden table carries the data for screen readers. */
export function ChartRender({ data, cfg, schema, height = 320, compact }: { data: AggResult; cfg: ChartConfig; schema: Prop[]; height?: number; compact?: boolean }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; title: string; rows: { label: string; value: string; color: string }[] } | null>(null);
  const valueProp = schema.find((p) => p.id === data.prop);
  const xProp = schema.find((p) => p.id === cfg.xProp);
  const gProp = schema.find((p) => p.id === cfg.groupProp);
  const multi = data.series.length > 1;
  const optionAxis = !multi && !!xProp && ['select', 'status', 'multi_select'].includes(xProp.type);
  const seriesColor = (si: number) => colorFor(si, data.series[si]?.color && gProp && ['select', 'status', 'multi_select'].includes(gProp.type) ? data.series[si].color : undefined);
  const pointColor = (pi: number, si: number) => (optionAxis ? colorFor(pi, data.points[pi].color ?? 'default') : multi ? seriesColor(si) : 'var(--viz-1)');
  const valueLabel = `${FN_LABEL[data.fn] ?? 'Count'}${valueProp ? ` of ${valueProp.name}` : ''}`;

  if (cfg.kind === 'number') {
    return (
      <div className="chart-number" ref={wrapRef}>
        <div className="chart-number-value">{fmt(data.total, valueProp)}</div>
        <div className="chart-number-label">{valueLabel}</div>
      </div>
    );
  }
  if (!data.points.length) return <div className="chart-empty" ref={wrapRef}>No data for this chart yet.</div>;

  const legend = (cfg.showLegend ?? true) && (multi || cfg.kind === 'donut') && (
    <div className="chart-legend" aria-hidden>
      {(cfg.kind === 'donut' ? data.points.map((p, i) => ({ label: p.label, color: colorFor(i, optionAxis ? p.color ?? 'default' : undefined) }))
        : data.series.map((s, i) => ({ label: s.label, color: seriesColor(i) }))).map((l, i) => (
        <span key={i} className="chart-legend-item"><span className="chart-swatch" style={{ background: l.color }} />{l.label}</span>
      ))}
    </div>
  );
  const srTable = (
    <table className="sr-only">
      <caption>{valueLabel}{xProp ? ` by ${xProp.name}` : ''}</caption>
      <thead><tr><th>{xProp?.name ?? 'Category'}</th>{data.series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
      <tbody>{data.points.map((p) => <tr key={p.key}><td>{p.label}</td>{data.series.map((s) => <td key={s.key}>{p.values[s.key]}</td>)}</tr>)}</tbody>
    </table>
  );
  const showTip = (e: React.MouseEvent, pi: number) => {
    const p = data.points[pi];
    const box = wrapRef.current!.getBoundingClientRect();
    setTip({
      x: e.clientX - box.left, y: e.clientY - box.top, title: p.label,
      rows: (multi ? data.series : [{ key: data.series[0].key, label: valueLabel }]).map((s, si) => ({ label: s.label, value: fmt(p.values[s.key] ?? 0, valueProp), color: pointColor(pi, si) })),
    });
  };
  const tooltip = tip && (
    <div className="chart-tip" style={{ left: Math.min(tip.x + 12, width - 180), top: Math.max(0, tip.y - 12) }}>
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => <div key={i} className="chart-tip-row"><span className="chart-swatch" style={{ background: r.color }} /><span>{r.label}</span><b>{r.value}</b></div>)}
    </div>
  );

  // ---- donut ----
  if (cfg.kind === 'donut') {
    const size = Math.min(height, width) - 8;
    const r = size / 2, inner = r * 0.62;
    const total = data.points.reduce((a, p) => a + Math.max(0, p.total), 0) || 1;
    let a0 = -Math.PI / 2;
    const arcs = data.points.map((p, i) => {
      const a1 = a0 + (Math.max(0, p.total) / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (rad: number, a: number) => `${r + rad * Math.cos(a)},${r + rad * Math.sin(a)}`;
      const d = p.total <= 0 ? '' : a1 - a0 >= Math.PI * 2 - 1e-6
        ? `M ${pt(r, a0)} A ${r} ${r} 0 1 1 ${pt(r, a0 + Math.PI)} A ${r} ${r} 0 1 1 ${pt(r, a0)} M ${pt(inner, a0)} A ${inner} ${inner} 0 1 0 ${pt(inner, a0 + Math.PI)} A ${inner} ${inner} 0 1 0 ${pt(inner, a0)} Z`
        : `M ${pt(r, a0)} A ${r} ${r} 0 ${large} 1 ${pt(r, a1)} L ${pt(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, a0)} Z`;
      a0 = a1;
      return { d, color: colorFor(i, optionAxis ? p.color ?? 'default' : undefined), i };
    });
    return (
      <div className="chart-wrap" ref={wrapRef} onMouseLeave={() => setTip(null)}>
        <svg width={width} height={size} role="img" aria-label={`${valueLabel} by ${xProp?.name ?? 'category'}`}>
          <g transform={`translate(${(width - size) / 2},0)`}>
            {arcs.map((a) => a.d && <path key={a.i} d={a.d} fill={a.color} stroke="var(--bg)" strokeWidth={2} onMouseMove={(e) => showTip(e, a.i)} />)}
            <text x={r} y={r - 4} textAnchor="middle" className="chart-donut-total">{fmt(data.total, valueProp)}</text>
            <text x={r} y={r + 16} textAnchor="middle" className="chart-axis-label">{valueLabel}</text>
          </g>
        </svg>
        {legend}{tooltip}{srTable}
      </div>
    );
  }

  // ---- cartesian (column / bar / line / area) ----
  const horizontal = cfg.kind === 'bar';
  const stacked = (cfg.kind === 'column' || cfg.kind === 'bar') && multi;
  const stackTotals = data.points.map((p) => (stacked ? data.series.reduce((a, s) => a + Math.max(0, p.values[s.key] ?? 0), 0) : Math.max(0, ...data.series.map((s) => p.values[s.key] ?? 0))));
  const ticks = niceTicks(Math.max(0, ...stackTotals), stackTotals.every((t) => Number.isInteger(t)));
  const maxV = ticks[ticks.length - 1];
  const labelW = horizontal ? Math.min(160, Math.max(60, ...data.points.map((p) => p.label.length * 6.5))) : 44;
  const pad = { top: 12, right: 16, bottom: horizontal ? 24 : compact ? 28 : 44, left: labelW };
  const h = horizontal ? Math.max(height, data.points.length * 28 + pad.top + pad.bottom) : height;
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = Math.max(40, h - pad.top - pad.bottom);
  const n = data.points.length;
  const band = (horizontal ? plotH : plotW) / n;
  const barW = Math.max(4, Math.min(48, band * 0.62));
  const scale = (v: number) => (v / maxV) * (horizontal ? plotW : plotH);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 70))));

  const marks: React.ReactNode[] = [];
  if (cfg.kind === 'column' || cfg.kind === 'bar') {
    data.points.forEach((p, pi) => {
      let acc = 0;
      const segs = multi && stacked ? data.series : [data.series[0]];
      segs.forEach((s, si) => {
        const v = Math.max(0, p.values[s.key] ?? 0);
        if (!v) return;
        const len = scale(v);
        const isTop = si === segs.length - 1 || segs.slice(si + 1).every((x) => !(p.values[x.key] > 0));
        const gap = acc > 0 ? 2 : 0; // 2px surface gap between stacked segments
        const center = (horizontal ? pad.top : pad.left) + band * pi + band / 2;
        const color = pointColor(pi, si);
        const common = { fill: color, onMouseMove: (e: React.MouseEvent) => showTip(e, pi), className: 'chart-mark' };
        if (horizontal) {
          const x = pad.left + scale(acc) + gap, w = Math.max(1, len - gap);
          marks.push(<path key={`${pi}-${si}`} {...common} d={roundedRect(x, center - barW / 2, w, barW, isTop ? 4 : 0, 'right')} />);
        } else {
          const y = pad.top + plotH - scale(acc) - len, hh = Math.max(1, len - gap);
          marks.push(<path key={`${pi}-${si}`} {...common} d={roundedRect(center - barW / 2, y, barW, hh, isTop ? 4 : 0, 'top')} />);
        }
        acc += v;
      });
      // hit target bigger than the mark
      const center = (horizontal ? pad.top : pad.left) + band * pi;
      marks.push(horizontal
        ? <rect key={`hit-${pi}`} x={pad.left} y={center} width={plotW} height={band} fill="transparent" onMouseMove={(e) => showTip(e, pi)} />
        : <rect key={`hit-${pi}`} x={center} y={pad.top} width={band} height={plotH} fill="transparent" onMouseMove={(e) => showTip(e, pi)} />);
    });
  } else {
    const x = (pi: number) => pad.left + band * pi + band / 2;
    const y = (v: number) => pad.top + plotH - scale(Math.max(0, v));
    data.series.forEach((s, si) => {
      const color = multi ? seriesColor(si) : 'var(--viz-1)';
      const pts = data.points.map((p, pi) => `${x(pi)},${y(p.values[s.key] ?? 0)}`);
      if (cfg.kind === 'area') {
        marks.push(<path key={`a-${si}`} d={`M ${x(0)},${pad.top + plotH} L ${pts.join(' L ')} L ${x(n - 1)},${pad.top + plotH} Z`} fill={color} opacity={multi ? 0.18 : 0.22} />);
      }
      marks.push(<polyline key={`l-${si}`} points={pts.join(' ')} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
      if (n <= 40) data.points.forEach((p, pi) => marks.push(<circle key={`c-${si}-${pi}`} cx={x(pi)} cy={y(p.values[s.key] ?? 0)} r={4} fill={color} stroke="var(--bg)" strokeWidth={2} />));
    });
    data.points.forEach((_, pi) => marks.push(<rect key={`hit-${pi}`} x={pad.left + band * pi} y={pad.top} width={band} height={plotH} fill="transparent" onMouseMove={(e) => showTip(e, pi)} />));
  }

  return (
    <div className="chart-wrap" ref={wrapRef} onMouseLeave={() => setTip(null)}>
      <svg width={width} height={h} role="img" aria-label={`${valueLabel}${xProp ? ` by ${xProp.name}` : ''}`}>
        {/* recessive grid + value axis */}
        {ticks.map((t, i) => horizontal ? (
          <g key={i}>
            <line x1={pad.left + scale(t)} x2={pad.left + scale(t)} y1={pad.top} y2={pad.top + plotH} className="chart-grid" />
            <text x={pad.left + scale(t)} y={h - 6} textAnchor="middle" className="chart-axis-label">{fmt(t, valueProp)}</text>
          </g>
        ) : (
          <g key={i}>
            <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH - scale(t)} y2={pad.top + plotH - scale(t)} className="chart-grid" />
            <text x={pad.left - 6} y={pad.top + plotH - scale(t) + 4} textAnchor="end" className="chart-axis-label">{fmt(t, valueProp)}</text>
          </g>
        ))}
        {/* category axis */}
        {data.points.map((p, pi) => horizontal ? (
          <text key={pi} x={pad.left - 8} y={pad.top + band * pi + band / 2 + 4} textAnchor="end" className="chart-axis-label">{trunc(p.label, 22)}</text>
        ) : pi % labelEvery === 0 ? (
          <text key={pi} x={pad.left + band * pi + band / 2} y={pad.top + plotH + 16} textAnchor="middle" className="chart-axis-label">{trunc(p.label, Math.max(6, Math.floor((band * labelEvery) / 7)))}</text>
        ) : null)}
        {marks}
      </svg>
      {legend}{tooltip}{srTable}
    </div>
  );
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

/** Rect path with only the data-end corners rounded (bars stay anchored square to the baseline). */
function roundedRect(x: number, y: number, w: number, h: number, r: number, end: 'top' | 'right') {
  r = Math.min(r, w / 2, h / 2);
  if (!r) return `M ${x},${y} h ${w} v ${h} h ${-w} Z`;
  if (end === 'top') return `M ${x},${y + h} V ${y + r} Q ${x},${y} ${x + r},${y} H ${x + w - r} Q ${x + w},${y} ${x + w},${y + r} V ${y + h} Z`;
  return `M ${x},${y} H ${x + w - r} Q ${x + w},${y} ${x + w},${y + r} V ${y + h - r} Q ${x + w},${y + h} ${x + w - r},${y + h} H ${x} Z`;
}

/** `view.config.filter` here is the effective filter (view filter + active quick filters), set by DatabaseView. */
export function ChartView({ db, view, search }: ViewProps) {
  const cfg = view.config.chart ?? defaultChart(db.schema);
  const { data, isLoading } = useAggregate(db.id, view.id, cfg, view.config.filter, search ?? '');
  if (!data) return <div className="db-loading">{isLoading ? <div className="spinner" /> : 'No data'}</div>;
  return <div className="chart-view"><ChartRender data={data} cfg={cfg} schema={db.schema} /></div>;
}

/** Chart options panel (view settings + dashboard widgets). */
export function ChartSettings({ schema, value, onChange }: { schema: Prop[]; value: ChartConfig; onChange: (c: ChartConfig) => void }) {
  const set = (patch: Partial<ChartConfig>) => onChange({ ...value, ...patch });
  const xProps = useMemo(() => schema.filter((p) => X_TYPES.includes(p.type)), [schema]);
  const valueProps = schema.filter((p) => VALUE_TYPES.includes(p.type));
  const xProp = schema.find((p) => p.id === value.xProp);
  const isDate = !!xProp && ['date', 'created_time', 'last_edited_time'].includes(xProp.type);
  return (
    <div className="chart-settings">
      <div className="chart-kinds" role="radiogroup" aria-label="Chart type">
        {CHART_KINDS.map((k) => (
          <button key={k.kind} role="radio" aria-checked={value.kind === k.kind} className={`chart-kind ${value.kind === k.kind ? 'on' : ''}`} title={k.label} onClick={() => set({ kind: k.kind })}>
            <k.icon size={16} /><span>{k.label}</span>
          </button>
        ))}
      </div>
      {value.kind !== 'number' && (
        <div className="vs-row"><span>{value.kind === 'donut' ? 'Slices' : 'X axis'}</span>
          <select className="input sm" value={value.xProp ?? ''} onChange={(e) => set({ xProp: e.target.value || undefined })}>
            <option value="">—</option>
            {xProps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {isDate && value.kind !== 'number' && (
        <div className="vs-row"><span>Group dates by</span>
          <select className="input sm" value={value.bucket ?? 'month'} onChange={(e) => set({ bucket: e.target.value as any })}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option>
          </select>
        </div>
      )}
      <div className="vs-row"><span>Value</span>
        <select className="input sm" value={value.aggregate.fn === 'count' ? 'count' : `${value.aggregate.fn}:${value.aggregate.prop ?? ''}`}
          onChange={(e) => {
            if (e.target.value === 'count') return set({ aggregate: { fn: 'count' } });
            const [fn, prop] = e.target.value.split(':');
            set({ aggregate: { fn: fn as any, prop } });
          }}>
          <option value="count">Count of pages</option>
          {valueProps.flatMap((p) => (['sum', 'avg', 'median', 'min', 'max'] as const).map((fn) => <option key={`${fn}:${p.id}`} value={`${fn}:${p.id}`}>{FN_LABEL[fn]} of {p.name}</option>))}
        </select>
      </div>
      {!['number', 'donut'].includes(value.kind) && (
        <div className="vs-row"><span>Group by</span>
          <select className="input sm" value={value.groupProp ?? ''} onChange={(e) => set({ groupProp: e.target.value || undefined })}>
            <option value="">None</option>
            {xProps.filter((p) => p.id !== value.xProp).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {value.kind !== 'number' && (
        <>
          <div className="vs-row"><span>Sort</span>
            <select className="input sm" value={value.sort ?? 'x-asc'} onChange={(e) => set({ sort: e.target.value as any })}>
              <option value="x-asc">Axis ascending</option><option value="x-desc">Axis descending</option>
              <option value="value-desc">Value high → low</option><option value="value-asc">Value low → high</option>
            </select>
          </div>
          {['line', 'area'].includes(value.kind) && (
            <label className="vs-row"><span>Cumulative</span><input type="checkbox" checked={!!value.cumulative} onChange={(e) => set({ cumulative: e.target.checked })} /></label>
          )}
          <label className="vs-row"><span>Hide empty groups</span><input type="checkbox" checked={!!value.hideEmpty} onChange={(e) => set({ hideEmpty: e.target.checked })} /></label>
          <label className="vs-row"><span>Show legend</span><input type="checkbox" checked={value.showLegend ?? true} onChange={(e) => set({ showLegend: e.target.checked })} /></label>
        </>
      )}
    </div>
  );
}

export function ChartViewSettings({ db, view }: { db: Database; view: DbView }) {
  return <ChartSettings schema={db.schema} value={view.config.chart ?? defaultChart(db.schema)} onChange={(chart) => updateView(db.id, view.id, { config: { chart } })} />;
}
