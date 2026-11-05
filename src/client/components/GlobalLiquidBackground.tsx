import { WebGLLiquid } from "@/components/ui/webgl-liquid";
import { useTheme } from "@/components/theme";
import { AutoTransition } from "@/components/ui/auto-transition";

export function GlobalLiquidBackground() {
  const { theme } = useTheme();
  const liquid = theme.liquid;
  const isStatic = theme.backdrop === "static";

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden" style={{ backgroundColor: theme.deep }}>
      <AutoTransition className="absolute inset-0" duration={0.55} transitionKey={theme.id} type="fade">
        {isStatic ? (
          <div
            className="h-full min-h-0"
            style={{
              backgroundColor: theme.deep,
              backgroundImage: `radial-gradient(120% 55% at 50% -12%, ${theme.mid}66, transparent 70%), radial-gradient(70% 40% at 85% 110%, ${theme.accent}1f, transparent 65%)`,
            }}
          />
        ) : (
          <WebGLLiquid
            title=""
            subtitle=""
            description=""
            colorDeep={theme.deep}
            colorMid={theme.mid}
            colorHighlight={theme.highlight}
            speed={liquid?.speed ?? 0.9}
            flowStrength={liquid?.flowStrength ?? 0.9}
            grain={liquid?.grain ?? 0.05}
            contrast={liquid?.contrast ?? 1.2}
            opacity={liquid?.opacity ?? 0.95}
            reveal
            delayMs={0}
            className="h-full min-h-0"
          />
        )}
      </AutoTransition>
    </div>
  );
}
