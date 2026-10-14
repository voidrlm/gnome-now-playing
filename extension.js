import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
// 22px tall like a workspace-indicator pill; width is the screen's aspect
// ratio times PILL_WIDTH_SCALE.
const PILL_HEIGHT = 22;
const PILL_WIDTH_SCALE = 2.4;
// Gap between the pill's edge and the art; matches .nowplaying-pill padding.
const ART_INSET = 0;
const ART_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'now-playing']);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
  </interface>
</node>`);

const AppProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

class Player {
    constructor(busName, onChange) {
        this.busName = busName;
        this.lastActive = 0;
        this._onChange = onChange;
        const bus = Gio.DBus.session;
        new AppProxy(bus, busName, MPRIS_PATH, (proxy, err) => {
            if (err || this._destroyed) return;
            this._app = proxy;
            onChange(this);
        });
        new PlayerProxy(bus, busName, MPRIS_PATH, (proxy, err) => {
            if (err || this._destroyed) return;
            this._player = proxy;
            this._propsId = proxy.connect('g-properties-changed', () => {
                if (this.playing) this.lastActive = Date.now();
                onChange(this);
            });
            if (this.playing) this.lastActive = Date.now();
            onChange(this);
        });
    }

    get ready() {
        return !!this._player && !!this.title;
    }

    get playing() {
        return this._player?.PlaybackStatus === 'Playing';
    }

    // Chrome briefly sends metadata without a title while switching tracks;
    // keep the last complete metadata so the panel doesn't hide and reappear.
    _meta(key) {
        const meta = this._player?.Metadata;
        if (meta?.['xesam:title']?.recursiveUnpack()) this._lastMeta = meta;
        return (this._lastMeta ?? meta)?.[key]?.recursiveUnpack();
    }

    get title() {
        return this._meta('xesam:title') ?? '';
    }

    get artist() {
        const a = this._meta('xesam:artist');
        return Array.isArray(a) ? a.join(', ') : a ?? '';
    }

    get album() {
        return this._meta('xesam:album') ?? '';
    }

    get artUrl() {
        return this._meta('mpris:artUrl') ?? '';
    }



    get identity() {
        return this._app?.Identity ?? this.busName.slice(MPRIS_PREFIX.length);
    }

    get app() {
        const entry = this._app?.DesktopEntry;
        return entry ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`) : null;
    }

    get canNext() {
        return !!this._player?.CanGoNext;
    }

    get canPrev() {
        return !!this._player?.CanGoPrevious;
    }

    get canPlayPause() {
        return !!(this._player?.CanPlay || this._player?.CanPause);
    }

    playPause() {
        this._player?.PlayPauseAsync().catch(() => {});
    }

    next() {
        this._player?.NextAsync().catch(() => {});
    }

    previous() {
        this._player?.PreviousAsync().catch(() => {});
    }

    raise() {
        this._app?.RaiseAsync().catch(() => {});
    }

    destroy() {
        this._destroyed = true;
        if (this._propsId) this._player.disconnect(this._propsId);
        this._player = this._app = null;
    }
}

export default class NowPlaying extends Extension {
    enable() {
        this._players = new Map();

        // No dropdown: the controls live in the panel itself.
        this._button = new PanelMenu.Button(0.5, this.metadata.name, true);
        this._button.reactive = false;
        this._button.add_style_class_name('nowplaying-panel');
        // A pill showing the album art with the controls always over it on a
        // light scrim (darker on hover). Clicking the art (outside the controls)
        // raises the player, middle-click toggles playback.
        this._session = new Soup.Session();
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._art = new St.Widget({style_class: 'nowplaying-art', x_expand: true, y_expand: true});
        this._panelIcon = new St.Icon({
            style_class: 'nowplaying-fallback-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const controls = new St.Widget({
            style_class: 'nowplaying-controls',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const inner = new St.BoxLayout({
            style_class: 'nowplaying-controls-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        controls.add_child(inner);
        stack.add_child(this._art);
        stack.add_child(this._panelIcon);
        stack.add_child(controls);

        const pill = new St.Button({
            style_class: 'nowplaying-pill',
            child: stack,
            y_align: Clutter.ActorAlign.CENTER,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
        });
        pill.connect('clicked', (_b, button) => {
            if (button === Clutter.BUTTON_MIDDLE) this._current?.playPause();
            else this._current?.raise();
        });
        pill.connect('notify::hover', () => this._syncTooltip());

        // Tooltip below the pill with the track details, shown while hovered.
        this._tooltip = new St.BoxLayout({
            style_class: 'nowplaying-tooltip',
            vertical: true,
            opacity: 0,
            visible: false,
        });
        this._tipTitle = new St.Label({style_class: 'nowplaying-tooltip-title'});
        this._tipSub = new St.Label({style_class: 'nowplaying-tooltip-sub'});
        [this._tipTitle, this._tipSub].forEach(l => this._tooltip.add_child(l));
        Main.layoutManager.addTopChrome(this._tooltip);

        const btn = icon => {
            const b = new St.Button({
                style_class: 'nowplaying-btn',
                child: new St.Icon({icon_name: icon, style_class: 'nowplaying-btn-icon'}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            inner.add_child(b);
            return b;
        };
        this._prevBtn = btn('media-skip-backward-symbolic');
        this._playBtn = btn('media-playback-start-symbolic');
        this._nextBtn = btn('media-skip-forward-symbolic');
        this._prevBtn.connect('clicked', () => this._current?.previous());
        this._playBtn.connect('clicked', () => this._current?.playPause());
        this._nextBtn.connect('clicked', () => this._current?.next());

        this._button.add_child(pill);
        this._pill = pill;
        global.display.connectObject('workareas-changed', () => this._syncSize(), this);
        this._syncSize();
        // Right side, just left of the performance gauge (or first, if the
        // gauge isn't loaded yet).
        const rightBox = Main.panel._rightBox;
        const gauge = Main.panel.statusArea['system-monitor-panel@arjun']?.container;
        const idx = Math.max(0, gauge ? rightBox.get_children().indexOf(gauge) : 0);
        Main.panel.addToStatusArea(this.uuid, this._button, idx, 'right');
        this._sync();

        const bus = Gio.DBus.session;
        this._nameSub = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (oldOwner) this._removePlayer(name);
                if (newOwner) this._addPlayer(name);
            });
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    console.error(`now-playing: ListNames failed: ${e}`);
                }
            });
    }

    _syncSize() {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        if (!workArea?.height)
            return;
        this._pill.set_size(Math.round(PILL_HEIGHT * PILL_WIDTH_SCALE * workArea.width / workArea.height), PILL_HEIGHT);
        this._sync();
    }

    _addPlayer(name) {
        if (this._players.has(name)) return;
        this._players.set(name, new Player(name, () => this._sync()));
    }

    _removePlayer(name) {
        this._players.get(name)?.destroy();
        this._players.delete(name);
        this._sync();
    }

    // Shows whichever player is playing (the most recent one if several),
    // otherwise the one that played last.
    _pick() {
        const ready = [...this._players.values()].filter(p => p.ready);
        const playing = ready.filter(p => p.playing);
        const pool = playing.length ? playing : ready;
        return pool.sort((a, b) => b.lastActive - a.lastActive)[0] ?? null;
    }

    _sync() {
        if (!this._button) return;
        const p = this._current = this._pick();
        this._button.visible = !!p;
        if (!p) return;

        const art = this._artFile(p.artUrl);
        const app = p.app;
        // Art fills the pill; without art, the app icon sits centred instead.
        // Only restyle (and re-read the image size) when the art or pill size changes.
        const [pw, ph] = this._pill.get_size();
        const artKey = art ? `${art.get_uri()}@${pw}x${ph}` : null;
        if (artKey !== this._artKey) {
            this._artKey = artKey;
            this._art.style = art ? `background-image: url("${art.get_uri()}");${this._coverSize(art)}` : null;
        }
        this._panelIcon.visible = !art;
        if (app) this._panelIcon.gicon = app.get_icon();
        else this._panelIcon.icon_name = 'audio-x-generic-symbolic';
        this._button.accessible_name = p.artist ? `${p.title} — ${p.artist}` : p.title;
        this._art.opacity = p.playing ? 255 : 140;

        this._playBtn.child.icon_name = p.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._playBtn.visible = p.canPlayPause;
        this._prevBtn.visible = p.canPrev;
        this._nextBtn.visible = p.canNext;

        const setLine = (label, text) => {
            label.text = text;
            label.visible = !!text;
        };
        setLine(this._tipTitle, p.title);
        setLine(this._tipSub, [p.artist, p.album].filter(Boolean).join(' · '));
        this._syncTooltip();
    }

    _syncTooltip() {
        const tip = this._tooltip;
        if (!tip) return;
        const show = !!(this._pill?.hover && this._current);
        if (show) {
            // Centre under the pill, kept on screen.
            const [x, y] = this._pill.get_transformed_position();
            const [w, h] = this._pill.get_transformed_size();
            const monitor = Main.layoutManager.findMonitorForActor(this._pill);
            tip.visible = true;
            const [, tw] = tip.get_preferred_width(-1);
            let tx = Math.round(x + (w - tw) / 2);
            if (monitor) tx = Math.max(monitor.x + 4, Math.min(tx, monitor.x + monitor.width - tw - 4));
            tip.set_position(tx, Math.round(y + h + 6));
        }
        if (tip._npShown === show) return;
        tip._npShown = show;
        tip.remove_all_transitions();
        tip.ease({
            opacity: show ? 255 : 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!show) tip.visible = false;
            },
        });
    }

    // Scale the art so it covers the whole pill (cropping the overflow),
    // instead of relying on St's `cover`, which left it letterboxed, and centre it.
    _coverSize(file) {
        const [, w, h] = GdkPixbuf.Pixbuf.get_file_info(file.get_path() ?? '') ?? [];
        // The art is inset by the pill's padding, so size the cover to that.
        const [pw, ph] = this._pill.get_size().map(v => v - 2 * ART_INSET);
        if (!w || !h || pw <= 0 || ph <= 0) return '';
        const scale = Math.max(pw / w, ph / h);
        const [bw, bh] = [Math.ceil(w * scale), Math.ceil(h * scale)];
        // St ignores the `center` keyword, so offset by hand to show the middle.
        const [x, y] = [Math.round((pw - bw) / 2), Math.round((ph - bh) / 2)];
        return ` background-size: ${bw}px ${bh}px; background-position: ${x}px ${y}px;`;
    }

    // Local art is used as is; remote art (e.g. Spotify) is downloaded to the
    // cache once and the panel re-synced when it lands.
    _artFile(url) {
        if (!url) return null;
        if (url.startsWith('file://')) return Gio.File.new_for_uri(url);
        if (!/^https?:\/\//.test(url)) return null;
        if (this._artUrl === url) return this._artUrlFile;
        const file = Gio.File.new_for_path(GLib.build_filenamev([ART_DIR,
            GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]));
        if (file.query_exists(null)) {
            // Remember the current track's art so later syncs skip the disk check.
            this._artUrl = url;
            this._artUrlFile = file;
            return file;
        }
        this._fetching ??= new Set();
        if (this._fetching.has(url)) return null;
        const msg = Soup.Message.new('GET', url);
        if (!msg) return null;
        this._fetching.add(url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) return;
                GLib.mkdir_with_parents(ART_DIR, 0o755);
                file.replace_contents(bytes.toArray(), null, false, Gio.FileCreateFlags.NONE, null);
                this._sync();
            } catch (e) {
                console.error(`now-playing: art download failed: ${e}`);
            } finally {
                this._fetching?.delete(url);
            }
        });
        return null;
    }

    disable() {
        this._session?.abort();
        this._session = null;
        this._fetching = null;
        global.display.disconnectObject(this);
        this._pill = null;
        this._tooltip?.destroy();
        this._tooltip = null;
        if (this._nameSub) Gio.DBus.session.signal_unsubscribe(this._nameSub);
        this._nameSub = 0;
        for (const p of this._players.values()) p.destroy();
        this._players = null;
        this._current = null;
        this._button?.destroy();
        this._button = null;
    }
}
