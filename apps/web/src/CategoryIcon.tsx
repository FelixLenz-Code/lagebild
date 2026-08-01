/**
 * Symbole für Suchtreffer. Die Kategorien kommen aus dem Offline-Index bzw.
 * aus der Photon-Antwort (gleiche Schlüssel) — hier werden sie auf eine kleine
 * Menge Strichzeichnungen abgebildet.
 */

type Glyph =
  | 'pin'
  | 'place'
  | 'street'
  | 'address'
  | 'fuel'
  | 'parking'
  | 'health'
  | 'shield'
  | 'cart'
  | 'food'
  | 'bed'
  | 'bank'
  | 'train'
  | 'bus'
  | 'plane'
  | 'ship'
  | 'school'
  | 'tree'
  | 'water'
  | 'view'
  | 'building'
  | 'tool';

const BY_CATEGORY: Record<string, Glyph> = {
  place: 'place',
  street: 'street',
  address: 'address',
  fuel: 'fuel',
  charging: 'fuel',
  parking: 'parking',
  pharmacy: 'health',
  hospital: 'health',
  doctor: 'health',
  police: 'shield',
  fire_station: 'shield',
  supermarket: 'cart',
  bakery: 'cart',
  shop: 'cart',
  restaurant: 'food',
  cafe: 'food',
  fast_food: 'food',
  bar: 'food',
  hotel: 'bed',
  atm: 'bank',
  bank: 'bank',
  post: 'bank',
  station: 'train',
  tram_stop: 'train',
  bus_stop: 'bus',
  airport: 'plane',
  ferry_terminal: 'ship',
  harbour: 'ship',
  school: 'school',
  kindergarten: 'school',
  university: 'school',
  museum: 'building',
  townhall: 'building',
  church: 'building',
  park: 'tree',
  forest: 'tree',
  camp: 'tree',
  water: 'water',
  swimming: 'water',
  drinking_water: 'water',
  viewpoint: 'view',
  peak: 'view',
  workshop: 'tool',
  recycling: 'tool',
};

const PATHS: Record<Glyph, JSX.Element> = {
  pin: <path d="M12 21s-6-5.7-6-10a6 6 0 1 1 12 0c0 4.3-6 10-6 10Z M12 11h.01" />,
  place: (
    <>
      <circle cx="12" cy="10" r="7" />
      <path d="M12 17v4M8 21h8" />
    </>
  ),
  street: <path d="M6 21 9 3M18 21l-3-18M12 6v3M12 12v3M12 18v2" />,
  address: (
    <>
      <path d="M4 10 12 4l8 6v10H4z" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  fuel: (
    <>
      <path d="M5 20V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15M3 20h12M6 10h6" />
      <path d="M16 8l2 2v7a1.5 1.5 0 0 0 3 0V9l-3-3" />
    </>
  ),
  parking: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3" />
    </>
  ),
  health: <path d="M12 4v16M4 12h16" />,
  shield: (
    <>
      <path d="M12 3l7 2.5V11c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V5.5z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  cart: (
    <>
      <path d="M3 4h2l2.4 10.2A2 2 0 0 0 9.3 16h7.5a2 2 0 0 0 2-1.6L20 7H6" />
      <circle cx="10" cy="20" r="1.2" />
      <circle cx="17" cy="20" r="1.2" />
    </>
  ),
  food: (
    <>
      <path d="M6 3v8a2 2 0 0 0 4 0V3M8 11v10" />
      <path d="M17 3c-1.5 1.5-2 3-2 5.5 0 1.5.7 2.5 2 2.5v10" />
    </>
  ),
  bed: (
    <>
      <path d="M3 18v-8h12a4 4 0 0 1 4 4v4M3 14h16M3 18h18" />
      <circle cx="7" cy="12" r="1.4" />
    </>
  ),
  bank: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.4" />
    </>
  ),
  train: (
    <>
      <rect x="6" y="3" width="12" height="13" rx="3" />
      <path d="M6 11h12M9 20l-2 2M15 20l2 2M9.5 16h5" />
    </>
  ),
  bus: (
    <>
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <path d="M4 11h16M7 20v-3M17 20v-3" />
    </>
  ),
  plane: <path d="M2 13l20-7-7 20-2.5-8.5L2 13Z" />,
  ship: (
    <>
      <path d="M4 17l1.5-5h13L20 17" />
      <path d="M12 12V7M8 7h8" />
      <path d="M3 19c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0" />
    </>
  ),
  school: (
    <>
      <path d="M12 4 2 9l10 5 10-5-10-5Z" />
      <path d="M6 11.5V17c0 1.5 3 3 6 3s6-1.5 6-3v-5.5" />
    </>
  ),
  tree: (
    <>
      <path d="M12 3 6 12h4l-4 6h12l-4-6h4L12 3Z" />
      <path d="M12 18v3" />
    </>
  ),
  water: <path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z" />,
  view: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M9 21v-5h6v5M8 10h.01M12 10h.01M16 10h.01" />
    </>
  ),
  tool: <path d="M14.5 5.5a4 4 0 0 0 5 5L21 9v6l-9 6-9-6V9l7.5-4.5Z" />,
};

export function CategoryIcon({ category, size = 17 }: { category?: string | null; size?: number }) {
  const glyph = (category && BY_CATEGORY[category]) || 'pin';
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[glyph]}
    </svg>
  );
}
