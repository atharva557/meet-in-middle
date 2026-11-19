// Result card: winning venue, each friend's drive, fairness toggle, alternatives, share.
import type { VenueResult } from '../worker/protocol.ts';
import { fmtMin, statsOf, type Mode } from '../scoring.ts';
import { renderModeSeg } from './panel.ts';

export interface ResultView {
  venue: VenueResult;
  friends: { name: string; color: string; lat: number; lon: number }[];
  mode: Mode;
  alts: { index: number; venue: VenueResult }[];
}

export interface ResultHooks {
  onMode(mode: Mode): void;
  onAlt(index: number): void;
  onShare(): void;
}

const KIND_LABEL = { cafe: 'Café', restaurant: 'Restaurant', food: 'Quick bites', mall: 'Mall' } as const;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class ResultCard {
  readonly el = $<HTMLElement>('result');

  constructor(private hooks: ResultHooks) {
    $<HTMLButtonElement>('r-share').onclick = () => hooks.onShare();
    $<HTMLButtonElement>('result-grip').onclick = () => this.setCollapsed(!this.el.classList.contains('collapsed'));
  }

  setCollapsed(c: boolean): void {
    this.el.classList.toggle('collapsed', c);
    document.body.classList.toggle('result-collapsed', c);
  }

  show(v: ResultView): void {
    const s = statsOf(v.venue.times);
    $('r-kind').textContent = `${KIND_LABEL[v.venue.kind]} · meet here`;
    $('r-name').textContent = v.venue.name;
    const em = (m: Mode, txt: string) => (m === v.mode ? `<b>${txt}</b>` : txt);
    $('r-summary').innerHTML = [
      em('max', `longest ${fmtMin(s.max)}`),
      em('total', `total ${fmtMin(s.total)}`),
      em('gap', `gap ${fmtMin(s.gap)}`),
    ].join(' · ');

    const trips = $('r-trips');
    trips.replaceChildren(...v.friends.map((f, i) => {
      const li = document.createElement('li');
      li.className = 'trip';
      li.style.color = f.color;
      const t = v.venue.times[i];
      const dir = `https://www.google.com/maps/dir/?api=1&origin=${f.lat},${f.lon}&destination=${v.venue.lat},${v.venue.lon}&travelmode=driving`;
      li.innerHTML = `<span class="dot"></span><span class="who"></span><span class="t">${fmtMin(t)}<a target="_blank" rel="noopener" href="${dir}">route</a></span>
        <span class="bar"><i style="width:${Math.max(4, (t / s.max) * 100).toFixed(1)}%"></i></span>`;
      (li.querySelector('.who') as HTMLElement).textContent = f.name;
      (li.querySelector('.who') as HTMLElement).style.color = 'var(--text)';
      return li;
    }));

    renderModeSeg($('r-mode-seg'), $('r-mode-blurb'), v.mode, (m) => this.hooks.onMode(m));

    const alts = $('r-alts');
    alts.replaceChildren();
    if (v.alts.length) {
      const p = document.createElement('p');
      p.textContent = 'Also good';
      alts.append(p);
      for (const a of v.alts) {
        const as = statsOf(a.venue.times);
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span></span><span></span>';
        b.children[0].textContent = a.venue.name;
        b.children[1].textContent = `${KIND_LABEL[a.venue.kind]} · max ${fmtMin(as.max)}`;
        b.onclick = () => this.hooks.onAlt(a.index);
        alts.append(b);
      }
    }
    $<HTMLAnchorElement>('r-maps').href = `https://www.google.com/maps/search/?api=1&query=${v.venue.lat},${v.venue.lon}`;
    this.el.hidden = false;
    this.el.classList.remove('away');
    document.body.classList.add('has-result');
  }

  hide(): void {
    this.el.hidden = true;
    this.setCollapsed(false);
    document.body.classList.remove('has-result');
  }
}
