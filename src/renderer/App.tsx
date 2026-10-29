import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type {
  AppStatus,
  AssetView,
  CullLabel,
  CullState,
  ExportSet,
  Group,
  PackId,
  PairCandidate,
  ProgressEvent,
  ProjectCommand,
  ProjectSnapshot,
  ProjectState,
  ReviewState,
} from '../shared/contracts';
import { AllGrid, GroupList } from './components/Grid';
import { LIST_LABEL } from './components/CullPanel';
import { Compare } from './components/Compare';
import { ExportDialog } from './components/ExportDialog';
import { AiSettingsDialog } from './components/AiSettingsDialog';
import { LocalAnalysisControls } from './components/LocalAnalysisControls';
import { ReviewBar } from './components/ReviewBar';
import { PackPanel, PACK_LABEL } from './components/PackPanel';
import { SourcePanel } from './components/SourcePanel';
import { api, isTypingTarget, STATE_LABEL } from './lib';
import { useAssetPages } from './useAssets';
import { Icon } from './components/Icon';
import { LiquidDefs, LiquidSeg, useLiquidPointer } from './liquid';

type ScanProgress = Extract<ProgressEvent, { kind: 'scan' }>;
type AutoCullProgress = Extract<ProgressEvent, { kind: 'autocull' }>;
type Mode = 'all' | 'groups' | CullLabel;
const LISTS: CullLabel[] = ['keep', 'better-option', 'review'];

const PHASE_LABEL: Record<AutoCullProgress['phase'], string> = {
  hashing: 'kiểm tra bản sao',
  grouping: 'gom nhóm',
  analysis: 'phân tích khuôn mặt',
  ranking: 'xếp hạng',
  complete: 'hoàn tất',
  paused: 'tạm dừng',
  cancelled: 'đã hủy',
  failed: 'lỗi',
};

function cullStatusText(running: AutoCullProgress | null, state: CullState | null): string {
  if (running) return `AutoCull: đang ${PHASE_LABEL[running.phase]}${running.total ? ` ${running.done}/${running.total}` : ''}…`;
  const run = state?.run;
  if (!run) return 'AutoCull: Chưa chạy';
  const at = new Date(run.createdAt).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  if (run.status === 'complete') return `AutoCull: Hoàn tất (${at})`;
  if (run.status === 'paused') return `AutoCull tạm dừng (${at}): ${run.error ?? ''}`;
  if (run.status === 'cancelled') return `AutoCull đã hủy (${at}) — kết quả trước đó vẫn dùng`;
  if (run.status === 'running') return 'AutoCull: đang chạy…';
  return `AutoCull lỗi: ${run.error ?? ''}`;
}

function Wordmark(props: { size?: 'lg' }) {
  return (
    <span className={`wordmark${props.size ? ` wordmark--${props.size}` : ''}`}>
      EventStory<span className="wordmark-accent">Cull</span>
    </span>
  );
}

function Welcome(props: { onOpened: (s: ProjectSnapshot) => void; onError: (m: string) => void }) {
  const [name, setName] = useState('');
  const act = async (fn: () => Promise<{ ok: true; value: ProjectSnapshot | null } | { ok: false; code: string; message: string }>) => {
    const r = await fn();
    if (!r.ok) props.onError(r.message);
    else if (r.value) props.onOpened(r.value);
  };
  return (
    <main className="welcome">
      <div className="welcome-hero">
        <span className="welcome-eyebrow lg">
          <span className="eyebrow-dot" />
          Lọc ảnh sự kiện trước Lightroom
        </span>
        <h1 className="welcome-title">
          <Wordmark size="lg" />
        </h1>
        <p className="welcome-subtitle">
          Gom nhóm, chọn và xuất ảnh RAW sự kiện theo cụm và mục tiêu bàn giao.
          <span className="welcome-safe">
            <Icon name="shield" size={14} /> Ảnh gốc chỉ đọc — không sửa, không đổi tên.
          </span>
        </p>
      </div>

      <div className="welcome-cards-grid">
        <form
          className="card card-primary lg lg-lens"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void act(() => api().createProject(name.trim()));
          }}
        >
          <div className="card-header">
            <span className="card-icon">
              <Icon name="sparkle" size={18} />
            </span>
            <h2>Dự án mới</h2>
          </div>
          <label>
            <span>Tên sự kiện / Album</span>
            <input
              data-testid="new-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VD: Hội nghị thường niên 28/10 · Wedding An &amp; Bình"
              maxLength={120}
              autoFocus
            />
          </label>
          <button data-testid="create-project" type="submit" className="primary welcome-cta" disabled={!name.trim()}>
            <span>Tạo dự án &amp; Chọn nơi lưu…</span>
            <Icon name="arrowRight" className="btn-arrow" />
          </button>
          <p className="dim small card-footnote">
            Cơ sở dữ liệu và bộ đệm xem trước (preview cache) được lưu trong thư mục riêng biệt, bảo vệ tuyệt đối thư mục ảnh nguồn.
          </p>
        </form>

        <div className="card card-secondary lg lg-lens">
          <div className="card-header">
            <span className="card-icon">
              <Icon name="folder" size={18} />
            </span>
            <h2>Tiếp tục làm việc</h2>
          </div>
          <p className="dim small card-desc">Mở lại dự án đã tạo trên máy này hoặc nạp tệp phiên từ đồng nghiệp.</p>
          <div className="welcome-action-buttons">
            <button data-testid="open-project" className="welcome-open-btn" onClick={() => void act(() => api().openProject())}>
              <Icon name="folder" />
              <span>Mở dự án…</span>
            </button>
            <button data-testid="import-portable" className="welcome-portable-btn" onClick={() => void act(() => api().importPortable())}>
              <Icon name="file" />
              <span>Mở tệp phiên máy khác…</span>
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function ProjectView(props: { snapshot: ProjectSnapshot; onClose: () => void; onError: (m: string) => void; extraPanels?: (ctx: PanelContext) => React.ReactNode }) {
  const projectId = props.snapshot.id;
  const { onError } = props;
  const [state, setState] = useState<ProjectState | null>(null);
  const [pairs, setPairs] = useState<PairCandidate[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<Mode>('all');
  const [stateFilter, setStateFilter] = useState<ReviewState | ''>('');
  const [packFilter, setPackFilter] = useState<PackId | null>(null);
  const [exportPack, setExportPack] = useState<ExportSet | null>(null);
  const [cullState, setCullState] = useState<CullState | null>(null);
  const [autocull, setAutocull] = useState<AutoCullProgress | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareIds, setCompareIds] = useState<string[] | null>(null);
  const [scans, setScans] = useState<Record<string, ScanProgress>>({});
  const [scanMessages, setScanMessages] = useState<string[]>([]);
  const [showMessages, setShowMessages] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [analyses, setAnalyses] = useState<Record<string, { done: number; total: number }>>({});
  const [, setViewTick] = useState(0);
  const views = useRef(new Map<string, AssetView>());
  const cols = useRef(4);
  const lastRefresh = useRef(0);
  const finishedRuns = useRef(new Set<string>());

  const remember = useCallback((list: AssetView[]) => {
    for (const v of list) views.current.set(v.id, v);
    setViewTick((x) => x + 1);
  }, []);

  const listMode = mode !== 'all' && mode !== 'groups' ? mode : null;
  const filter = useMemo(
    () => ({
      ...(stateFilter ? { state: stateFilter } : {}),
      ...(search ? { text: search } : {}),
      ...(packFilter ? { packId: packFilter } : {}),
      ...(listMode ? { list: listMode } : {}),
    }),
    [stateFilter, search, packFilter, listMode],
  );
  const pages = useAssetPages(projectId, filter, version, remember);

  const refresh = useCallback(async () => {
    const [s, p, g, c] = await Promise.all([api().getProjectState(projectId), api().listPairCandidates(projectId), api().listGroups(projectId), api().getCullState(projectId)]);
    if (s.ok) setState(s.value);
    else onError(s.message);
    if (p.ok) setPairs(p.value);
    if (g.ok) setGroups(g.value);
    if (c.ok) setCullState(c.value);
    setVersion((v) => v + 1);
  }, [projectId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    return api().onProgress((e) => {
      if (e.kind === 'worker-restarted') {
        void refresh();
        return;
      }
      if (e.kind === 'analysis' && e.projectId === projectId) {
        setAutocull((cur) => cur?.runId === e.jobId && e.phase === 'progress'
          ? { ...cur, phase: 'analysis', done: e.done, total: e.total }
          : cur);
        setAnalyses((m) => {
          const next = { ...m };
          if (e.phase === 'progress') next[e.jobId] = { done: e.done, total: e.total };
          else delete next[e.jobId];
          return next;
        });
        if (e.message && e.phase !== 'progress') onError(e.message);
        else if (e.message) setScanMessages((list) => [...list.slice(-499), e.message!]);
        const t = Date.now();
        if (e.phase !== 'progress' || t - lastRefresh.current > 1500) {
          lastRefresh.current = t;
          void refresh();
        }
        return;
      }
      if (e.kind === 'autocull' && e.projectId === projectId) {
        const terminal = e.phase === 'complete' || e.phase === 'paused' || e.phase === 'cancelled' || e.phase === 'failed';
        if (terminal) finishedRuns.current.add(e.runId);
        setAutocull(terminal || finishedRuns.current.has(e.runId) ? null : e);
        if (terminal || e.phase === 'ranking') {
          lastRefresh.current = Date.now();
          void refresh();
        }
        return;
      }
      if (e.kind !== 'scan' || e.projectId !== projectId) return;
      if (e.phase === 'file-error' && e.message) setScanMessages((list) => [...list.slice(-499), e.message!]);
      if (e.phase === 'complete' && e.message) onError(e.message);
      setScans((m) => {
        const next = { ...m };
        if (e.phase === 'complete' || e.phase === 'cancelled') delete next[e.jobId];
        else if (e.phase !== 'file-error') next[e.jobId] = e;
        return next;
      });
      const now = Date.now();
      if (e.phase === 'complete' || e.phase === 'cancelled' || now - lastRefresh.current > 1500) {
        lastRefresh.current = now;
        void refresh();
      }
    });
  }, [projectId, refresh, onError]);

  // Navigation order
  const groupOrder = useMemo(() => {
    const visible = groups.map((g) => ({ ...g, assetIds: g.assetIds }));
    return { groups: visible, flat: visible.flatMap((g) => g.assetIds) };
  }, [groups]);

  const currentId = mode !== 'groups' ? (pages.at(focus)?.id ?? null) : focusId;
  const currentView = currentId ? views.current.get(currentId) : undefined;

  const selectionIds = useMemo(() => [...selected], [selected]);
  const targetIds = useCallback((): string[] => (selected.size ? [...selected] : currentId ? [currentId] : []), [selected, currentId]);

  const run = useCallback(
    async (command: ProjectCommand): Promise<boolean> => {
      const r = await api().applyCommand(projectId, command);
      if (!r.ok) {
        onError(r.message);
        return false;
      }
      await refresh();
      return true;
    },
    [projectId, onError, refresh],
  );

  const pickAll = (index: number, e: MouseEvent) => {
    const v = pages.at(index);
    if (!v) return;
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.size === 0 && currentId) n.add(currentId);
        if (n.has(v.id)) n.delete(v.id);
        else n.add(v.id);
        return n;
      });
    } else if (e.shiftKey) {
      const [a, b] = [Math.min(focus, index), Math.max(focus, index)];
      const n = new Set<string>();
      for (let i = a; i <= b; i++) {
        const x = pages.at(i);
        if (x) n.add(x.id);
      }
      setSelected(n);
    } else {
      setSelected(new Set());
    }
    setFocus(index);
  };

  const pickGroup = (id: string, e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.size === 0 && focusId) n.add(focusId);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    } else setSelected(new Set());
    setFocusId(id);
  };

  const move = useCallback(
    (delta: number, vertical = false) => {
      setSelected(new Set());
      if (mode !== 'groups') {
        const total = pages.total ?? 0;
        const step = vertical ? delta * cols.current : delta;
        setFocus((f) => Math.min(Math.max(0, f + step), Math.max(0, total - 1)));
      } else {
        const flat = groupOrder.flat;
        if (!flat.length) return;
        const i = focusId ? flat.indexOf(focusId) : -1;
        if (vertical) {
          const gi = groupOrder.groups.findIndex((g) => g.assetIds.includes(focusId ?? ''));
          const ng = groupOrder.groups[Math.min(Math.max(0, gi + delta), groupOrder.groups.length - 1)];
          if (ng) setFocusId(ng.assetIds[0]!);
        } else setFocusId(flat[Math.min(Math.max(0, i + delta), flat.length - 1)]!);
      }
    },
    [mode, pages.total, groupOrder, focusId],
  );

  const openCompare = useCallback(
    (single = false) => {
      if (!currentId) return;
      if (single) return setCompareIds([currentId]);
      if (selected.size >= 2) return setCompareIds([...selected].slice(0, 2));
      const nextId = mode !== 'groups' ? pages.at(focus + 1)?.id : groupOrder.flat[groupOrder.flat.indexOf(currentId) + 1];
      setCompareIds(nextId ? [currentId, nextId] : [currentId]);
    },
    [currentId, selected, mode, pages, focus, groupOrder],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (exportPack || showMessages || aiOpen) return; // a dialog owns the keyboard
      if (compareIds) {
        if (e.key === 'Escape') setCompareIds(null);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void run({ type: 'undo' });
        return;
      }
      if (mod || e.altKey) return;
      const ids = targetIds();
      const k = e.key.toLowerCase();
      if (/^[0-5]$/.test(e.key) && ids.length) void run({ type: 'set-rating', assetIds: ids, rating: Number(e.key) });
      else if (k === 'k' && ids.length) void run({ type: 'set-review', assetIds: ids, state: 'keep' });
      else if (k === 'x' && ids.length) void run({ type: 'set-review', assetIds: ids, state: 'pass' });
      else if (k === 'r' && ids.length) void run({ type: 'set-review', assetIds: ids, state: 'review' });
      else if (k === 'u' && ids.length) void run({ type: 'set-review', assetIds: ids, state: 'unreviewed' });
      else if ((k === 'q' || k === 'e') && ids.length) {
        const packId = k === 'q' ? 'quick' : 'edit';
        const member = !currentView?.packs[packId].member;
        void run({ type: 'set-pack-member', packId, assetIds: ids, member });
      } else if (k === 'c') openCompare();
      else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        openCompare(true);
      } else if (e.key === 'ArrowRight') move(1);
      else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1, true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1, true);
      } else return;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compareIds, run, targetIds, move, openCompare, currentView, exportPack, showMessages, aiOpen]);

  // groupId -> data version already loaded (or loading). Groups larger than one page are paged through.
  const groupLoads = useRef(new Map<string, number>());
  const loadGroup = useCallback(
    async (groupId: string): Promise<void> => {
      for (let offset = 0; ; offset += 200) {
        const r = await api().queryAssets(projectId, { offset, limit: 200, groupId });
        if (!r.ok) return;
        remember(r.value.items);
        if (offset + 200 >= r.value.total) return;
      }
    },
    [projectId, remember],
  );
  const requestGroup = useCallback(
    (groupId: string) => {
      if (groupLoads.current.get(groupId) === version) return;
      groupLoads.current.set(groupId, version);
      void loadGroup(groupId);
    },
    [loadGroup, version],
  );

  const compareWithPick = useCallback(async () => {
    if (!currentId) return;
    const g = groups.find((x) => x.assetIds.includes(currentId));
    if (!g) return;
    await loadGroup(g.id);
    const members = g.assetIds.map((id) => views.current.get(id)).filter((v): v is AssetView => !!v);
    const pick = members.find((v) => v.cull.selected && v.id !== currentId) ?? members.find((v) => v.id === views.current.get(currentId)?.cull.bestAssetId && v.id !== currentId);
    setCompareIds(pick ? [currentId, pick.id] : [currentId]);
  }, [currentId, groups, loadGroup]);

  useEffect(() => {
    if (mode === 'groups' && !focusId && groupOrder.flat[0]) setFocusId(groupOrder.flat[0]);
  }, [mode, focusId, groupOrder]);

  useEffect(() => {
    setFocus(0);
  }, [filter]);

  const scanning = Object.values(scans);
  const focusGroup = currentId ? groups.find((g) => g.assetIds.includes(currentId)) : undefined;

  if (!state)
    return (
      <main className="loading">
        <span className="loader" aria-hidden="true" />
        Đang mở dự án…
      </main>
    );
  const ctx: PanelContext = { projectId, state, run, refresh, onError: props.onError, selectionIds, currentView, version };
  return (
    <div className="workspace">
      <header className="topbar lg">
        <div className="topbar-id">
          <Wordmark />
          <span className="topbar-sep" aria-hidden="true" />
          <strong className="pname" title={state.snapshot.name}>{state.snapshot.name}</strong>
          <span className="counter" data-testid="count-assets">
            {state.logicalAssets} ảnh
          </span>
          <span className="counter counter--muted" data-testid="count-files">
            {state.physicalFiles} tệp gốc
          </span>
          {state.snapshot.dirty && <span className="warn chip-warn">Chưa lưu được thay đổi gần nhất!</span>}
        </div>
        <div className="topbar-status">
          {scanning.length > 0 ? (
            <span className="scan scan--busy" data-testid="scan-progress">
              <span className="pulse-dot" aria-hidden="true" />
              Đang xử lý: {scanning.reduce((s, x) => s + x.done, 0)}/{scanning.reduce((s, x) => s + x.total, 0)} tệp
              {scanning.map((x) => (
                <button key={x.jobId} onClick={() => void api().cancelJob(x.jobId)}>
                  Hủy
                </button>
              ))}
            </span>
          ) : (
            <span className="scan dim" data-testid="scan-idle">
              <span className="idle-dot" aria-hidden="true" />
              Sẵn sàng
            </span>
          )}
          {Object.values(analyses).length > 0 && (
            <span className="scan scan--busy" data-testid="analysis-progress">
              <span className="pulse-dot" aria-hidden="true" />
              Phân tích AI: {Object.values(analyses).reduce((s, x) => s + x.done, 0)}/{Object.values(analyses).reduce((s, x) => s + x.total, 0)}
              {Object.keys(analyses).map((id) => (
                <button key={id} onClick={() => void api().cancelJob(id)}>
                  Hủy
                </button>
              ))}
            </span>
          )}
          <span
            className={`scan${autocull ? ' scan--busy' : ''}${cullState?.run?.status === 'paused' && !autocull ? ' warn' : ''}`}
            data-testid="autocull-status"
            title={cullState?.run?.error ?? ''}
          >
            {cullStatusText(autocull, cullState)}
          </span>
        </div>
        <div className="topbar-actions">
          <div className="dock lg lg-lens" aria-label="AutoCull">
            <LocalAnalysisControls projectId={projectId} disabled={!!autocull || Object.keys(scans).length > 0 || Object.keys(analyses).length > 0}
              onError={onError} onStarted={(runId) => { if (!finishedRuns.current.has(runId)) setAutocull({ kind: 'autocull', projectId, runId, phase: 'hashing', done: 0, total: 0 }); }} />
            {autocull ? (
              <button data-testid="cancel-autocull" className="danger" onClick={() => void api().cancelJob(autocull.runId)}>
                <Icon name="stop" />
                Hủy AutoCull
              </button>
            ) : (
              <button
                data-testid="start-autocull"
                className="cloud"
                disabled={scanning.length > 0}
                title="Gom nhóm, phân tích và đề xuất ảnh giữ cho toàn bộ album. Không thay đổi lựa chọn thủ công."
                onClick={async () => {
                  const r = await api().startAutoCull(projectId);
                  if (!r.ok) onError(r.message);
                  else if (!finishedRuns.current.has(r.value)) setAutocull((cur) => cur ?? { kind: 'autocull', projectId, runId: r.value, phase: 'hashing', done: 0, total: 0 });
                }}
              >
                <Icon name="cloud" />
                AutoCull AWS
              </button>
            )}
          </div>
          <button data-testid="export-selection" className="primary" onClick={() => setExportPack('selection')} disabled={!cullState || cullState.counts.keep === 0}>
            <Icon name="export" />
            Xuất ảnh đã chọn ({cullState?.counts.keep ?? 0})
          </button>
          <div className="dock dock--tools lg" aria-label="Công cụ">
            {scanMessages.length > 0 && (
              <button className="warnbtn" onClick={() => setShowMessages(!showMessages)} data-testid="scan-messages">
                <Icon name="bell" />
                Thông báo ({scanMessages.length})
              </button>
            )}
            <button className="ghost" onClick={() => void run({ type: 'undo' })} disabled={!state.canUndo} title="Ctrl/⌘+Z">
              <Icon name="undo" />
              Hoàn tác
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const r = await api().exportPortable(projectId);
                if (!r.ok) props.onError(r.message);
              }}
              title="Lưu quyết định để tiếp tục trên máy khác (không chứa ảnh)"
            >
              <Icon name="save" />
              Lưu tệp phiên…
            </button>
            <button className="ghost" data-testid="open-ai-settings" onClick={() => setAiOpen(true)}>
              <Icon name="settings" />
              Cài đặt AWS
            </button>
            <button className="ghost" onClick={props.onClose}>
              <Icon name="logout" />
              Đóng dự án
            </button>
          </div>
        </div>
      </header>
      <SourcePanel
        projectId={projectId}
        state={state}
        pairs={pairs}
        scanning={scanning.length > 0}
        run={run}
        onError={props.onError}
        onAddSource={async () => {
          const r = await api().chooseSources(projectId);
          if (!r.ok) props.onError(r.message);
        }}
        onRelink={async (sourceId) => {
          const r = await api().relinkSource(projectId, sourceId);
          if (!r.ok) props.onError(r.message);
          else if (r.value) {
            props.onError(`Liên kết lại: ${r.value.matched} khớp, ${r.value.missing} không thấy, ${r.value.ambiguous} mơ hồ (không tự gán).`);
            void refresh();
          }
        }}
      />
      <section className="center">
        <div className="toolbar">
          <LiquidSeg label="Chế độ xem">
            <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
              Tất cả ảnh
            </button>
            {LISTS.map((l) => (
              <button key={l} className={`${mode === l ? 'on' : ''} list-${l}`} onClick={() => setMode(l)} data-testid={`list-${l}`}>
                <span className={`seg-dot dot-${l}`} aria-hidden="true" />
                {LIST_LABEL[l]} ({cullState?.counts[l] ?? 0})
              </button>
            ))}
            <button className={mode === 'groups' ? 'on' : ''} onClick={() => setMode('groups')} data-testid="mode-groups">
              Theo cụm ({groups.filter((g) => g.assetIds.length > 1).length})
            </button>
          </LiquidSeg>
          {mode !== 'groups' && (
            <>
              <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as ReviewState | '')} aria-label="Lọc theo quyết định">
                <option value="">Mọi quyết định</option>
                {(Object.keys(STATE_LABEL) as ReviewState[]).map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABEL[s]}
                  </option>
                ))}
              </select>
              {packFilter && (
                <button className="on" onClick={() => setPackFilter(null)} title="Bỏ lọc">
                  Bộ {PACK_LABEL[packFilter]} ×
                </button>
              )}
              <label className="search">
                <Icon name="search" />
                <input data-testid="search" type="search" placeholder="Tìm theo tên tệp…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
              </label>
            </>
          )}
          {mode === 'groups' && focusGroup && (
            <>
              <button
                disabled={selected.size === 0 || selected.size >= focusGroup.assetIds.length || [...selected].some((id) => !focusGroup.assetIds.includes(id))}
                onClick={() => void run({ type: 'split-group', groupId: focusGroup.id, assetIds: [...selected] })}
                title="Chọn vài ảnh trong cụm (Ctrl+bấm) rồi tách thành cụm riêng"
              >
                Tách ảnh đã chọn
              </button>
              <button
                disabled={(() => {
                  const ids = new Set([...selected].map((id) => groups.find((g) => g.assetIds.includes(id))?.id));
                  return ids.size < 2;
                })()}
                onClick={() => {
                  const ids = [...new Set([...selected].map((id) => groups.find((g) => g.assetIds.includes(id))!.id))];
                  void run({ type: 'merge-groups', groupIds: ids });
                }}
                title="Chọn ảnh ở hai cụm trở lên (Ctrl+bấm) rồi gộp"
              >
                Gộp các cụm đã chọn
              </button>
              <button onClick={() => void run({ type: 'regroup' })}>Gom lại (giữ cụm đã chỉnh tay)</button>
              {cullState?.groupingPreset === 'group-v1' && (
                <button
                  data-testid="regroup-event"
                  title="Dự án tạo bằng bản 0.1 đang gom theo khoảng cách 2 giây. Cách mới: ≤ 4 giây giữa hai khung, cả nhóm ≤ 10 giây."
                  onClick={() => void run({ type: 'regroup', preset: 'event-v2' })}
                >
                  Gom lại theo cách mới (4 s)
                </button>
              )}
            </>
          )}
          <span className="spacer" />
          <span className="shortcuts dim small">
            <kbd>←</kbd>
            <kbd>→</kbd>
            <kbd>↑</kbd>
            <kbd>↓</kbd> · <kbd>1–5</kbd> · <kbd>K</kbd>
            <kbd>X</kbd>
            <kbd>R</kbd>
            <kbd>U</kbd> · <kbd>Q</kbd>
            <kbd>E</kbd> · <kbd>C</kbd> so sánh · <kbd>Space</kbd> xem lớn
          </span>
        </div>
        {mode !== 'groups' ? (
          <AllGrid
            total={pages.total}
            at={pages.at}
            focus={focus}
            selected={selected}
            onPick={pickAll}
            onOpen={(i) => {
              setFocus(i);
              const v = pages.at(i);
              if (v) setCompareIds([v.id]);
            }}
            onColumns={(c) => (cols.current = c)}
          />
        ) : (
          <GroupList
            groups={groupOrder.groups}
            views={(id) => views.current.get(id)}
            requestGroup={requestGroup}
            focusId={focusId}
            selected={selected}
            onPick={pickGroup}
            onOpen={(id) => setCompareIds([id])}
          />
        )}
      </section>
      <div className="rightcol">
        <ReviewBar
          view={currentView}
          selectionIds={selectionIds}
          targets={state.targets}
          run={run}
          onOpenLoupe={() => openCompare(true)}
          analyzing={Object.keys(analyses).length > 0}
          onCompareBest={
            currentView && (groups.find((g) => g.assetIds.includes(currentView.id))?.assetIds.length ?? 1) > 1 ? () => void compareWithPick() : null
          }
          onAnalyze={async (ids, retry) => {
            const r = await api().analyzeFaces(projectId, ids, retry === true);
            if (!r.ok) onError(r.message);
            else setAnalyses((m) => ({ ...m, [r.value]: { done: 0, total: ids.length } }));
          }}
        />
        <details className="legacy" data-testid="legacy-panel">
          <summary>Dữ liệu cũ (v0.1): bộ chọn &amp; mục tiêu</summary>
          <PackPanel
            ctx={ctx}
            packFilter={packFilter}
            setPackFilter={(p) => {
              setPackFilter(p);
              if (p) setMode('all');
            }}
            onExport={setExportPack}
          />
        </details>
        {props.extraPanels?.(ctx)}
      </div>
      {aiOpen && <AiSettingsDialog onClose={() => setAiOpen(false)} />}
      {showMessages && (
        <div className="modal" role="dialog" aria-label="Thông báo quét">
          <div className="modal-card lg">
            <h3>Thông báo khi quét</h3>
            <ul className="small">
              {scanMessages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
            <div className="row buttons">
              <button onClick={() => setScanMessages([])}>Xóa danh sách</button>
              <button onClick={() => setShowMessages(false)}>Đóng</button>
            </div>
          </div>
        </div>
      )}
      {exportPack && <ExportDialog projectId={projectId} packId={exportPack} onClose={() => setExportPack(null)} onError={onError} />}
      {compareIds && (
        <Compare
          assets={compareIds.map((id) => views.current.get(id)).filter((v): v is AssetView => !!v)}
          onClose={() => setCompareIds(null)}
        />
      )}
    </div>
  );
}

export interface PanelContext {
  projectId: string;
  state: ProjectState;
  run: (c: ProjectCommand) => Promise<boolean>;
  refresh: () => Promise<void>;
  onError: (m: string) => void;
  selectionIds: string[];
  currentView: AssetView | undefined;
  version: number;
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api()
      .getAppStatus()
      .then((r) => (r.ok ? setStatus(r.value) : setNotice(r.message)));
    void api()
      .restoreLastProject()
      .then((r) => {
        if (r.ok && r.value) setProject(r.value);
        else if (!r.ok && r.code !== 'PROJECT_LOCKED') setNotice(r.message);
        else if (!r.ok) setNotice(r.message);
      })
      .finally(() => setRestoring(false));
  }, []);

  const onError = useCallback((m: string) => setNotice(m), []);
  useLiquidPointer();

  return (
    <div className="app">
      <LiquidDefs />
      <div className="ambient" aria-hidden="true">
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
      </div>
      {notice && (
        <div className="notice lg lg-lens" role="alert">
          <span className="notice-text">{notice}</span> <button onClick={() => setNotice(null)}>Đóng</button>
        </div>
      )}
      {restoring ? (
        <main className="loading">
          <span className="loader" aria-hidden="true" />
          Đang khởi động…
        </main>
      ) : project ? (
        <ProjectView
          key={project.id}
          snapshot={project}
          onError={onError}
          onClose={async () => {
            await api().closeProject(project.id);
            setProject(null);
          }}
        />
      ) : (
        <Welcome onOpened={setProject} onError={onError} />
      )}
      <footer className={`statusbar dim worker-${status?.worker ?? 'starting'}`} data-testid="worker-status">
        <span className="worker-dot" aria-hidden="true" />
        {status ? `Bộ xử lý: ${status.worker} · ExifTool ${status.exiftoolVersion ?? 'không chạy được'} · Electron ${status.electronVersion}` : 'Đang khởi động…'}
        <span className="spacer" />
        <span className="statusbar-name">EventStory Cull{status ? ` ${status.appVersion}` : ''}</span>
      </footer>
    </div>
  );
}
