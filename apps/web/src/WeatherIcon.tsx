import type { ReactElement } from 'react';

/**
 * Wettersymbole zu den Bright-Sky-Icon-Namen. Bewusst schlichte Strichgrafiken
 * im Stil der übrigen App-Icons; Sonne/Mond und Niederschlag sind farbig
 * abgesetzt, damit die Vorhersage auf einen Blick lesbar ist.
 */

const SUN = '#e0a90b';
const MOON = '#8aa4c8';
const DROP = '#3f83d4';
const SNOW = '#7fb4e6';
const BOLT = '#e08a1e';

/** Wolkenumriss, den sich fast alle Symbole teilen. */
const CLOUD = 'M7.5 18h9a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.2A3.6 3.6 0 0 0 7.5 18Z';

function Sun({ cx = 12, cy = 12, r = 4 }: { cx?: number; cy?: number; r?: number }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <g stroke={SUN} strokeWidth={1.8} strokeLinecap="round">
      <circle cx={cx} cy={cy} r={r} fill="none" />
      {rays.map((deg) => {
        const a = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={cx + Math.cos(a) * (r + 1.8)}
            y1={cy + Math.sin(a) * (r + 1.8)}
            x2={cx + Math.cos(a) * (r + 3.4)}
            y2={cy + Math.sin(a) * (r + 3.4)}
          />
        );
      })}
    </g>
  );
}

function Moon({ x = 0, y = 0, scale = 1 }: { x?: number; y?: number; scale?: number }) {
  return (
    <path
      transform={`translate(${x} ${y}) scale(${scale})`}
      d="M18 14.5A7 7 0 0 1 9.5 6a6.5 6.5 0 1 0 8.5 8.5Z"
      fill="none"
      stroke={MOON}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  );
}

function Cloud({ color = 'currentColor' }: { color?: string }) {
  return <path d={CLOUD} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />;
}

function Drops({ color = DROP, count = 3, dy = 0 }: { color?: string; count?: number; dy?: number }) {
  const xs = count === 2 ? [10, 14] : [8.5, 12, 15.5];
  return (
    <g stroke={color} strokeWidth={1.8} strokeLinecap="round">
      {xs.map((x, i) => (
        <line key={x} x1={x} y1={19.5 + dy + (i % 2)} x2={x - 1} y2={22 + dy + (i % 2)} />
      ))}
    </g>
  );
}

function Flakes({ color = SNOW }: { color?: string }) {
  return (
    <g stroke={color} strokeWidth={1.6} strokeLinecap="round">
      {[9, 12.5, 16].map((x, i) => (
        <g key={x} transform={`translate(${x} ${20.5 + (i % 2)})`}>
          <line x1={-1.6} y1={0} x2={1.6} y2={0} />
          <line x1={-0.8} y1={-1.4} x2={0.8} y2={1.4} />
          <line x1={-0.8} y1={1.4} x2={0.8} y2={-1.4} />
        </g>
      ))}
    </g>
  );
}

const ICONS: Record<string, ReactElement> = {
  'clear-day': <Sun />,
  'clear-night': <Moon />,
  'partly-cloudy-day': (
    <>
      <Sun cx={9} cy={8} r={2.8} />
      <Cloud />
    </>
  ),
  'partly-cloudy-night': (
    <>
      <Moon x={2} y={-3.5} scale={0.62} />
      <Cloud />
    </>
  ),
  cloudy: <Cloud />,
  fog: (
    <>
      <Cloud />
      <g stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" opacity={0.75}>
        <line x1={6} y1={20.5} x2={18} y2={20.5} />
        <line x1={8} y1={23} x2={16} y2={23} />
      </g>
    </>
  ),
  rain: (
    <>
      <Cloud />
      <Drops />
    </>
  ),
  sleet: (
    <>
      <Cloud />
      <Drops count={2} />
      <g stroke={SNOW} strokeWidth={1.6} strokeLinecap="round" transform="translate(16.5 21)">
        <line x1={-1.6} y1={0} x2={1.6} y2={0} />
        <line x1={-0.8} y1={-1.4} x2={0.8} y2={1.4} />
        <line x1={-0.8} y1={1.4} x2={0.8} y2={-1.4} />
      </g>
    </>
  ),
  snow: (
    <>
      <Cloud />
      <Flakes />
    </>
  ),
  hail: (
    <>
      <Cloud />
      <g fill={SNOW}>
        <circle cx={9} cy={21} r={1.2} />
        <circle cx={12.5} cy={22} r={1.2} />
        <circle cx={16} cy={21} r={1.2} />
      </g>
    </>
  ),
  thunderstorm: (
    <>
      <Cloud />
      <path d="M13 18.5 10 22.5h3l-1 3.5" fill="none" stroke={BOLT} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
      <Drops count={2} dy={0.5} />
    </>
  ),
  wind: (
    <g stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" fill="none">
      <path d="M4 9h9a2.5 2.5 0 1 0-2.5-2.5" />
      <path d="M4 14h13a2.5 2.5 0 1 1-2.5 2.5" />
      <path d="M4 19h6" />
    </g>
  ),
};

/**
 * Bright Sky beschreibt mit `icon` die Bewölkung und mit `condition` den
 * Niederschlag. Regen/Schnee/Gewitter/Nebel sind handlungsrelevanter — die
 * gewinnen deshalb gegen das Wolkensymbol.
 */
const CONDITION_WINS = new Set(['rain', 'sleet', 'snow', 'hail', 'thunderstorm', 'fog']);

/** Fällt auf ein passendes Symbol zurück, wenn der Name unbekannt ist. */
export function WeatherIcon({
  icon,
  condition,
  size = 24,
  title,
}: {
  icon?: string | null;
  condition?: string | null;
  size?: number;
  title?: string;
}) {
  const key =
    (condition && CONDITION_WINS.has(condition) && ICONS[condition] ? condition : null) ??
    (icon && ICONS[icon] ? icon : null) ??
    (condition && ICONS[condition] ? condition : null) ??
    'cloudy';
  return (
    <svg
      className="wicon"
      viewBox="0 0 26 26"
      width={size}
      height={size}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* Die Motive sind für ein 24er-Raster gezeichnet — hier mittig gerückt. */}
      <g transform="translate(1 -0.5)">{ICONS[key]}</g>
    </svg>
  );
}
