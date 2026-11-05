import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeId =
  | "midnight-drift"
  | "glacier-blue"
  | "signal-mint"
  | "solar-ember"
  | "rose-circuit"
  | "ultraviolet"
  | "lunar-ash"
  | "verdant-relay"
  | "coral-ping"
  | "citron-relay"
  | "seeker-blue";

export type ThemeLiquidTuning = {
  contrast?: number;
  flowStrength?: number;
  grain?: number;
  opacity?: number;
  speed?: number;
};

export type ThemeRadiusTokens = Partial<Record<"card" | "control" | "panel", string>>;

export type AppTheme = {
  accent: string;
  backdrop?: "static";
  deep: string;
  description: Record<"en" | "zh", string>;
  highlight: string;
  id: ThemeId;
  liquid?: ThemeLiquidTuning;
  mid: string;
  name: Record<"en" | "zh", string>;
  radius?: ThemeRadiusTokens;
  scheme?: "light";
};

export const appThemes: readonly AppTheme[] = [
  {
    id: "midnight-drift",
    name: { en: "Midnight Drift", zh: "深夜漂移" },
    description: { en: "For one more thing at 2 AM.", zh: "适合再处理一件事的深夜" },
    deep: "#02040b",
    mid: "#11315e",
    highlight: "#67d5ff",
    accent: "#67d5ff",
  },
  {
    id: "glacier-blue",
    name: { en: "Glacier Blue", zh: "冰川蓝" },
    description: { en: "Cool enough to make routers shiver.", zh: "冷得路由器都想加外套" },
    deep: "#031015",
    mid: "#15566c",
    highlight: "#8defff",
    accent: "#8defff",
  },
  {
    id: "signal-mint",
    name: { en: "Signal Mint", zh: "信号薄荷" },
    description: { en: "Mouthwash for your bandwidth.", zh: "给带宽来一口薄荷" },
    deep: "#03100e",
    mid: "#0f605d",
    highlight: "#68efd5",
    accent: "#68efd5",
  },
  {
    id: "solar-ember",
    name: { en: "Solar Ember", zh: "余烬信号" },
    description: { en: "Looks like overtime. It is file transfer.", zh: "看起来像加班 其实在传文件" },
    deep: "#100603",
    mid: "#783215",
    highlight: "#ffad61",
    accent: "#ffad61",
  },
  {
    id: "rose-circuit",
    name: { en: "Rose Circuit", zh: "玫色电路" },
    description: { en: "Bug reports, now with flowers.", zh: "连 Bug 报告都带着花香" },
    deep: "#10040c",
    mid: "#702050",
    highlight: "#ff91ca",
    accent: "#ff91ca",
  },
  {
    id: "ultraviolet",
    name: { en: "Ultraviolet", zh: "紫外静电" },
    description: { en: "Contains an ambiguous amount of cosmos.", zh: "含有成分不明的宇宙电费" },
    deep: "#09050f",
    mid: "#40247a",
    highlight: "#bca4ff",
    accent: "#bca4ff",
  },
  {
    id: "lunar-ash",
    name: { en: "Lunar Ash", zh: "月蚀灰" },
    description: { en: "Monday, but in elegant gray.", zh: "星期一 但至少是高级灰" },
    deep: "#080a0f",
    mid: "#374151",
    highlight: "#d5dce8",
    accent: "#d5dce8",
  },
  {
    id: "verdant-relay",
    name: { en: "Verdant Relay", zh: "绿野中继" },
    description: { en: "For packets that enjoy fresh air.", zh: "数据包也该呼吸新鲜空气" },
    deep: "#021009",
    mid: "#155b3a",
    highlight: "#82f2b2",
    accent: "#82f2b2",
  },
  {
    id: "coral-ping",
    name: { en: "Coral Ping", zh: "珊瑚回声" },
    description: { en: "A polite notification with a sunburn.", zh: "像晒红了的礼貌通知" },
    deep: "#120606",
    mid: "#7b2f2a",
    highlight: "#ff9b8f",
    accent: "#ff9b8f",
  },
  {
    id: "citron-relay",
    name: { en: "Citron Relay", zh: "柠檬中继" },
    description: { en: "Bright enough to make packets pucker.", zh: "亮得让数据包都眯起眼" },
    deep: "#100f02",
    mid: "#71630f",
    highlight: "#ffe86a",
    accent: "#ffe86a",
  },
  {
    id: "seeker-blue",
    name: { en: "Seeker Blue", zh: "求索蓝" },
    description: { en: "Calm daylight, quietly seeking.", zh: "安静的日间蓝 一直在求索" },
    deep: "#f5f7fb",
    mid: "#c9d9f9",
    highlight: "#4d6bfe",
    accent: "#4d6bfe",
    backdrop: "static",
    radius: { card: "1.25rem", control: "0.75rem", panel: "1.75rem" },
    scheme: "light",
  },
] as const;

const storageKey = "zestsend-theme";

type ThemeContextValue = {
  setThemeId: (id: ThemeId) => void;
  theme: AppTheme;
  themeId: ThemeId;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeId(value: string | null): value is ThemeId {
  return appThemes.some((theme) => theme.id === value);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>(() => {
    if (typeof window === "undefined") return "midnight-drift";
    const storedThemeId = window.localStorage.getItem(storageKey);
    return isThemeId(storedThemeId) ? storedThemeId : "midnight-drift";
  });

  const theme = useMemo(
    () => appThemes.find((candidate) => candidate.id === themeId) ?? appThemes[0],
    [themeId],
  );

  useEffect(() => {
    window.localStorage.setItem(storageKey, themeId);
    const root = document.documentElement;
    root.style.setProperty("--zest-scrollbar-thumb", theme.accent);
    root.style.colorScheme = theme.scheme === "light" ? "light" : "dark";
    root.dataset.theme = themeId;
    const radiusTokens: ThemeRadiusTokens = {
      card: theme.radius?.card,
      control: theme.radius?.control,
      panel: theme.radius?.panel,
    };
    for (const [token, value] of Object.entries(radiusTokens)) {
      if (value) root.style.setProperty(`--zest-radius-${token}`, value);
      else root.style.removeProperty(`--zest-radius-${token}`);
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.deep);
  }, [themeId]);

  return (
    <ThemeContext.Provider value={{ theme, themeId, setThemeId }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider.");
  return value;
}
