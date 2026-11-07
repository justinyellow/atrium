import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin } from 'lucide-react';
import type { Database, DbView, PlaceValue } from '../lib/types';
import { updateView } from './dbutil';
import type { ViewProps } from './shared';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Map of rows by a place property (Notion map view). OpenStreetMap tiles; marker popups open the row. */
export function MapView({ db, view, rows, openRow, canEdit }: ViewProps) {
  const placeProp = db.schema.find((p) => p.id === view.config.map?.placeProp) ?? db.schema.find((p) => p.type === 'place');
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const openRef = useRef(openRow);
  openRef.current = openRow;
  const fitted = useRef(false);
  const points = useMemo(
    () => (placeProp ? rows.map((r) => ({ row: r, v: r.props[placeProp.id] as PlaceValue | null })).filter((x) => x.v && Number.isFinite(x.v.lat) && Number.isFinite(x.v.lng)) : []),
    [rows, placeProp],
  );

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([0, 20], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; fitted.current = false; };
  }, [placeProp?.id]);

  useEffect(() => {
    const m = map.current, lg = layer.current;
    if (!m || !lg) return;
    lg.clearLayers();
    const icon = L.divIcon({ className: 'map-pin', html: '<span class="map-pin-dot"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
    for (const { row, v } of points) {
      const mk = L.marker([v!.lat, v!.lng], { icon, title: row.title || 'Untitled', keyboard: true });
      const html = document.createElement('div');
      html.className = 'map-popup';
      html.innerHTML = `<strong>${esc(row.title || 'Untitled')}</strong>${v!.name || v!.address ? `<div>${esc(v!.name ?? '')}${v!.address ? ` · ${esc(v!.address)}` : ''}</div>` : ''}<button type="button" class="map-open">Open</button>`;
      html.querySelector('button')!.addEventListener('click', () => openRef.current(row.id));
      mk.bindPopup(html);
      lg.addLayer(mk);
    }
    // Fit once (live refreshes keep the user's zoom/pan).
    if (points.length && !fitted.current) {
      fitted.current = true;
      m.fitBounds(L.latLngBounds(points.map((p) => [p.v!.lat, p.v!.lng] as [number, number])).pad(0.2), { maxZoom: 13 });
    }
  }, [points]);

  const places = db.schema.filter((p) => p.type === 'place');
  if (!places.length) {
    return <div className="empty-state"><MapPin size={28} /><div>Add a <b>Place</b> property to show pages on a map.</div></div>;
  }
  return (
    <div className="map-view">
      {places.length > 1 && canEdit && <MapPropPicker db={db} view={view} />}
      <div ref={el} className="map-canvas" role="region" aria-label={`Map of ${db.title || 'database'} by ${placeProp?.name ?? 'place'}`} />
      <div className="faint map-count">{points.length} of {rows.length} pages have {placeProp?.name ?? 'a place'} set</div>
    </div>
  );
}

function MapPropPicker({ db, view }: { db: Database; view: DbView }) {
  return (
    <div className="vs-row" style={{ maxWidth: 320 }}><span>Show map by</span>
      <select className="input sm" value={view.config.map?.placeProp ?? ''} onChange={(e) => updateView(db.id, view.id, { config: { map: { placeProp: e.target.value } } })}>
        {db.schema.filter((p) => p.type === 'place').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}
