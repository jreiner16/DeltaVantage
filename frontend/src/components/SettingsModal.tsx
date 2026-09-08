import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onThemeChange: (t: "light" | "dark" | "mid") => void;
  onAccountReset: () => void;
}

export default function SettingsModal({
  open,
  onClose,
  onThemeChange,
  onAccountReset,
}: SettingsModalProps) {
  const [slippage, setSlippage] = useState("0.1");
  const [shareIncrement, setShareIncrement] = useState("1");
  const [minQty, setMinQty] = useState("1");
  const [maxQty, setMaxQty] = useState("1000000");
  const [startingCash, setStartingCash] = useState("100000");
  const [localTheme, setLocalTheme] = useState<"light" | "dark" | "mid">("dark");
  const [defaultInterval, setDefaultInterval] = useState("1Min");
  const [defaultLookback, setDefaultLookback] = useState("7");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setError("");
    setConfirmReset(false);
    api.settings()
      .then((d) => {
        const s = d.settings;
        setSlippage(String(s.slippage * 100));
        setShareIncrement(String(s.share_increment ?? 1));
        setMinQty(String(s.min_order_qty));
        setMaxQty(String(s.max_order_qty));
        setStartingCash(String(s.starting_cash));
        setLocalTheme(s.theme);
        setDefaultInterval(s.default_interval);
        setDefaultLookback(String(s.default_lookback_days));
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load settings")
      );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await api.updateSettings({
        slippage: (parseFloat(slippage) || 0) / 100,
        share_increment: parseFloat(shareIncrement) || 1,
        min_order_qty: parseInt(minQty, 10) || 1,
        max_order_qty: parseInt(maxQty, 10) || 1_000_000,
        starting_cash: parseFloat(startingCash) || 0,
        theme: localTheme,
        default_interval: defaultInterval || "1Min",
        default_lookback_days: parseInt(defaultLookback, 10) || 7,
      });
      onThemeChange(localTheme);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setError("");
    try {
      await api.resetAccount();
      onAccountReset();
      setConfirmReset(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-[var(--border-strong)] max-h-[85vh] flex w-full max-w-lg flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="window-titlebar">
          <span>Settings</span>
          <button
            onClick={onClose}
            className="bg-transparent border-0 text-black font-bold text-[11px] px-1 hover:bg-black/20"
            title="Close"
          >
            X
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <div className="bg-down-soft text-down mb-3 border border-[var(--down)] px-3 py-1.5 text-[10px]">{error}</div>
          )}

          {/* Appearance */}
          <Section title="Appearance">
            <Field label="Theme">
              <div className="flex gap-0">
                <button
                  onClick={() => setLocalTheme("dark")}
                  className={`flex-1 border px-2 py-1 text-[10px] font-bold ${
                    localTheme === "dark"
                      ? "border-[var(--accent)] text-accent"
                      : "border-[var(--border)] text-secondary"
                  }`}
                >
                  DARK
                </button>
                <button
                  onClick={() => setLocalTheme("light")}
                  className={`flex-1 border px-2 py-1 text-[10px] font-bold ${
                    localTheme === "light"
                      ? "border-[var(--accent)] text-accent"
                      : "border-[var(--border)] text-secondary"
                  }`}
                >
                  LIGHT
                </button>
                <button
                  onClick={() => setLocalTheme("mid")}
                  className={`flex-1 border px-2 py-1 text-[10px] font-bold ${
                    localTheme === "mid"
                      ? "border-[var(--accent)] text-accent"
                      : "border-[var(--border)] text-secondary"
                  }`}
                >
                  MID
                </button>
              </div>
            </Field>
          </Section>

          {/* Market data */}
          <Section title="Market Data">
            <Field label="Default Chart Interval">
              <select
                value={defaultInterval}
                onChange={(e) => setDefaultInterval(e.target.value)}
                className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
              >
                <option value="1Min">1 minute</option>
                <option value="5Min">5 minutes</option>
                <option value="15Min">15 minutes</option>
                <option value="1Hour">1 hour</option>
                <option value="1Day">1 day</option>
              </select>
              <p className="text-tertiary mt-1 text-[9px]">
                Size of each bar (chart granularity + strategy/backtest feed). Smaller
                intervals show more detail but noisier price action.
              </p>
            </Field>
            <Field label="Default Lookback (days)">
              <input
                type="number"
                min="1"
                max="365"
                value={defaultLookback}
                onChange={(e) => setDefaultLookback(e.target.value)}
                className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
              />
              <p className="text-tertiary mt-1 text-[9px]">
                How far back to load market data for charts, quotes and indicators.
                Longer history = slower loads.
              </p>
            </Field>
          </Section>

          {/* Order Settings */}
          <Section title="Order Settings">
            <Field label="Slippage (%)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
              />
              <p className="text-tertiary mt-1 text-[9px]">
                Adverse fill penalty on every order (0.1 = 0.1%).
              </p>
            </Field>

            <div className="grid grid-cols-3 gap-2">
              <Field label="Share Increment">
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={shareIncrement}
                  onChange={(e) => setShareIncrement(e.target.value)}
                  className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
                />
              </Field>
              <Field label="Min Order Qty">
                <input
                  type="number"
                  min="1"
                  value={minQty}
                  onChange={(e) => setMinQty(e.target.value)}
                  className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
                />
              </Field>
              <Field label="Max Order Qty">
                <input
                  type="number"
                  min="1"
                  value={maxQty}
                  onChange={(e) => setMaxQty(e.target.value)}
                  className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
                />
              </Field>
            </div>
            <p className="text-tertiary text-[9px]">
              Share increment = smallest tradable step (1 = whole shares); orders must be whole multiples
              of it and between min and max qty.
            </p>
          </Section>

          {/* Account */}
          <Section title="Account">
            <Field label="Starting Cash ($)">
              <input
                type="number"
                min="0"
                value={startingCash}
                onChange={(e) => setStartingCash(e.target.value)}
                className="border border-[var(--border)] bg-editor w-full px-2 py-1.5 text-[11px] text-primary outline-none"
              />
              <p className="text-tertiary mt-1 text-[9px]">
                Restored when you reset your paper portfolio.
              </p>
            </Field>

            <div className="border border-[var(--border)] p-2">
              <div className="text-primary mb-2 text-[11px]">
                Reset paper portfolio -- clears positions, trades, orders and P&L.
              </div>
              {!confirmReset ? (
                <button
                  onClick={() => setConfirmReset(true)}
                  className="w-full border border-[var(--down)] bg-transparent py-1.5 text-[10px] font-bold text-[var(--down)] hover:bg-down-soft"
                >
                  RESET PORTFOLIO
                </button>
              ) : (
                <div className="flex flex-col gap-1">
                  <button
                    onClick={handleReset}
                    disabled={resetting}
                    className="w-full border border-[var(--down)] bg-down-soft py-1.5 text-[10px] font-bold text-[var(--down)] disabled:opacity-50"
                  >
                    {resetting ? "RESETTING..." : "CLICK AGAIN TO CONFIRM"}
                  </button>
                  <button
                    onClick={() => setConfirmReset(false)}
                    className="border border-[var(--border)] bg-transparent py-1 text-[9px] text-secondary"
                  >
                    CANCEL
                  </button>
                </div>
              )}
            </div>
          </Section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-0 border-t border-[var(--border)] px-4 py-2">
          {saved && <span className="text-up mr-auto text-[10px] font-bold">SAVED</span>}
          {error && <span className="text-down mr-auto text-[10px]">{error}</span>}
          <button
            onClick={onClose}
            className="border border-[var(--border)] bg-transparent px-3 py-1 text-[10px] text-secondary"
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="border border-[var(--accent)] bg-transparent px-3 py-1 text-[10px] font-bold text-accent disabled:opacity-50"
          >
            {saving ? "SAVING..." : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-secondary mb-2 border-0 border-b border-[var(--border)] pb-1 text-[9px] font-bold uppercase tracking-[0.12em]">
        {title}
      </h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-primary mb-1 block text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}
