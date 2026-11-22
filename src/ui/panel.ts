// Friend list editor: names, address search (Nominatim), pin-drop, add/remove.
import { FRIEND_COLORS, MAX_FRIENDS, MIN_FRIENDS } from '../config.ts';
import { GeocodeError, searchPlaces, type Place } from '../geo/geocode.ts';
import { MODES, MODE_ORDER, type Mode } from '../scoring.ts';

export interface Friend {
  id: number;
  name: string;
  color: string;
  lat?: number;
  lon?: number;
  label?: string;
  error?: string;
}

export interface PanelHooks {
  /** Friend list or a location changed. */
  onChange(): void;
  onPick(friendId: number | null): void;
  onRun(): void;
  onMode(mode: Mode): void;
  onDemo(): void;
}

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/** Renders a 3-way fairness toggle into `el`. */
export function renderModeSeg(el: HTMLElement, blurb: HTMLElement, mode: Mode, onPick: (m: Mode) => void): void {
  el.replaceChildren(...MODE_ORDER.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(m === mode));
    b.textContent = MODES[m].label;
    b.onclick = () => onPick(m);
    return b;
  }));
  blurb.textContent = MODES[mode].blurb;
}

export class Panel {
  readonly friends: Friend[] = [];
  private nextId = 1;
  private rows = new Map<number, HTMLLIElement>();
  private list = $<HTMLOListElement>('#friend-list');
  private goBtn = $<HTMLButtonElement>('#go');
  private addBtn = $<HTMLButtonElement>('#add-friend');
  private demoBtn = $<HTMLButtonElement>('#demo');
  private errEl = $<HTMLParagraphElement>('#panel-error');
  /** True while a route search is running; survives re-renders. */
  private busy = false;
  pickingId: number | null = null;

  constructor(private hooks: PanelHooks) {
    this.addBtn.onclick = () => { this.add(); this.render(); this.focusLast(); hooks.onChange(); };
    this.goBtn.onclick = () => hooks.onRun();
    this.demoBtn.onclick = () => hooks.onDemo();
  }

  add(init: Partial<Friend> = {}): Friend {
    const used = new Set(this.friends.map((f) => f.color));
    const color = FRIEND_COLORS.find((c) => !used.has(c)) ?? FRIEND_COLORS[0];
    const f: Friend = { id: this.nextId++, name: `Friend ${this.friends.length + 1}`, color, ...init };
    this.friends.push(f);
    return f;
  }

  clear(): void { this.friends.length = 0; }

  remove(id: number): void {
    const i = this.friends.findIndex((f) => f.id === id);
    if (i >= 0) this.friends.splice(i, 1);
    if (this.pickingId === id) this.hooks.onPick(null);
  }

  located(): Friend[] { return this.friends.filter((f) => f.lat !== undefined && f.lon !== undefined); }

  setLocation(id: number, lat: number, lon: number, label?: string): void {
    const f = this.friends.find((x) => x.id === id);
    if (!f) return;
    f.lat = lat; f.lon = lon; f.label = label ?? f.label ?? 'Pinned on map'; f.error = undefined;
    this.render();
  }

  setMode(mode: Mode, onPick: (m: Mode) => void): void {
    renderModeSeg($('#mode-seg'), $('#mode-blurb'), mode, onPick);
  }

  setError(msg: string | null, retry?: () => void): void {
    this.errEl.hidden = !msg;
    this.errEl.textContent = msg ?? '';
    if (msg && retry) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = 'Retry';
      b.onclick = retry;
      this.errEl.append(' ', b);
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.demoBtn.disabled = busy;
    this.goBtn.disabled = busy || this.located().length < MIN_FRIENDS;
    this.goBtn.textContent = busy ? 'Working…' : 'Find the fair middle';
  }

  private focusLast(): void {
    const last = this.friends[this.friends.length - 1];
    if (last) this.rows.get(last.id)?.querySelector<HTMLInputElement>('input.q')?.focus();
  }

  /** Keyed render: rows are created once per friend and patched in place. */
  render(): void {
    const alive = new Set(this.friends.map((f) => f.id));
    for (const [id, row] of this.rows) if (!alive.has(id)) { row.remove(); this.rows.delete(id); }
    this.friends.forEach((f, i) => {
      let row = this.rows.get(f.id);
      if (!row) { row = this.createRow(f); this.rows.set(f.id, row); }
      if (this.list.children[i] !== row) this.list.insertBefore(row, this.list.children[i] ?? null);
      this.patchRow(row, f);
    });
    this.addBtn.disabled = this.friends.length >= MAX_FRIENDS;
    this.setBusy(this.busy);
  }

  private patchRow(row: HTMLLIElement, f: Friend): void {
    row.style.color = f.color;
    row.classList.toggle('err', !!f.error);
    const name = $<HTMLInputElement>('input.name', row);
    if (document.activeElement !== name) name.value = f.name;
    $<HTMLButtonElement>('.pin', row).classList.toggle('on', this.pickingId === f.id);
    $<HTMLButtonElement>('.remove', row).hidden = this.friends.length <= MIN_FRIENDS && f.lat === undefined;
    const st = $<HTMLParagraphElement>('.friend-status', row);
    st.className = 'friend-status' + (f.error ? ' bad' : f.lat !== undefined ? ' ok' : '');
    st.textContent = f.error ?? f.label ?? (this.pickingId === f.id ? 'Tap the map to place' : 'Search an address or drop a pin');
  }

  private createRow(f: Friend): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'friend';
    row.innerHTML = `
      <div class="friend-top">
        <span class="dot" aria-hidden="true"></span>
        <input class="name" type="text" maxlength="24" aria-label="Friend name" />
        <button class="icon-btn plain remove" type="button" aria-label="Remove friend">${ICON_X}</button>
      </div>
      <form class="friend-search">
        <input class="q" type="text" enterkeyhint="search" placeholder="Address, area or landmark" aria-label="Search address" />
        <button class="icon-btn" type="submit" aria-label="Search">${ICON_SEARCH}</button>
        <button class="icon-btn pin" type="button" aria-label="Drop a pin on the map">${ICON_PIN}</button>
      </form>
      <ul class="results" hidden></ul>
      <p class="friend-status"></p>`;

    const name = $<HTMLInputElement>('input.name', row);
    name.oninput = () => { f.name = name.value.trim() || 'Friend'; this.hooks.onChange(); };
    name.onblur = () => { name.value = f.name; };

    $<HTMLButtonElement>('.remove', row).onclick = () => {
      if (this.friends.length > MIN_FRIENDS) this.remove(f.id);
      else { f.lat = f.lon = f.label = f.error = undefined; }
      this.render();
      this.hooks.onChange();
    };

    $<HTMLButtonElement>('.pin', row).onclick = () => this.hooks.onPick(this.pickingId === f.id ? null : f.id);

    const form = $<HTMLFormElement>('form', row);
    const q = $<HTMLInputElement>('input.q', row);
    const results = $<HTMLUListElement>('.results', row);
    const status = () => $<HTMLParagraphElement>('.friend-status', row);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const query = q.value.trim();
      if (query.length < 3) return;
      status().className = 'friend-status';
      status().textContent = 'Searching…';
      results.hidden = true;
      let places: Place[];
      try {
        places = await searchPlaces(query);
      } catch (err) {
        f.error = err instanceof GeocodeError ? err.message : 'Search failed.';
        this.patchRow(row, f);
        f.error = undefined;
        return;
      }
      if (places.length === 0) {
        status().className = 'friend-status bad';
        status().textContent = 'No match in Ahmedabad. Try an area or landmark, or drop a pin.';
        return;
      }
      results.replaceChildren(...places.map((p) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = '<span></span><small></small>';
        b.children[0].textContent = p.label;
        b.children[1].textContent = p.detail;
        b.onclick = () => {
          results.hidden = true;
          q.value = '';
          this.setLocation(f.id, p.lat, p.lon, p.detail ? `${p.label}, ${p.detail.split(',')[0]}` : p.label);
          this.hooks.onChange();
        };
        li.append(b);
        return li;
      }));
      results.hidden = false;
      this.patchRow(row, f);
      (results.querySelector('button') as HTMLButtonElement | null)?.focus();
    };
    return row;
  }
}
