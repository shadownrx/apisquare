import { addDays, getToday, parseFecha, toDateStr } from './parse-fecha';
import { extractHoraCandidates, looksLikeHoraInput } from './parse-hora';

export type InfoQueryType =
  | 'obra_social'
  | 'horarios'
  | 'precios'
  | 'ubicacion'
  | 'pago'
  | 'cancelacion'
  | 'que_traer'
  | 'estacionamiento'
  | 'duracion';

export interface BotIntent {
  action: 'menu' | 'reservar' | 'misreservas' | 'servicios' | 'profesionales' | 'consulta' | 'unknown';
  parameters?: {
    profesional?: string;
    servicio?: string;
    fecha?: string;
    nombre?: string;
    /** Preferencia de franja al pedir turnos */
    franja?: 'manana' | 'tarde';
    hora?: string;
  };
}

/** Distancia de Levenshtein acotada (para typos cortos). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function wordsClose(a: string, b: string, maxDist = 1): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const allowed = a.length <= 4 || b.length <= 4 ? 1 : maxDist;
  return editDistance(a, b) <= allowed;
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => haystack.includes(n));
}

function hasWordCloseTo(haystack: string, candidates: string[], maxDist = 1): boolean {
  const words = haystack.split(/\s+/);
  return words.some(w => candidates.some(c => wordsClose(w, c, maxDist)));
}

/**
 * Normaliza texto humano: minúsculas, sin acentos, colapsa repeticiones,
 * corrige typos/argot muy comunes del chat argentino.
 */
export function normalizeHumanText(text: string): string {
  let t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s:?]/gu, ' ')
    // "quieroooo" / "turnooo" → una sola repetición extra como máximo
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Abreviaturas y typos frecuentes (después de colapsar letras)
  const fixes: Array<[RegExp, string]> = [
    [/\bqiero\b/g, 'quiero'],
    [/\bkiero\b/g, 'quiero'],
    [/\bkeiro\b/g, 'quiero'],
    [/\bxiero\b/g, 'quiero'],
    [/\bqiero\b/g, 'quiero'],
    [/\bkeria\b/g, 'queria'],
    [/\bqueria\b/g, 'queria'],
    [/\bnesesito\b/g, 'necesito'],
    [/\bnesecito\b/g, 'necesito'],
    [/\bnesito\b/g, 'necesito'],
    [/\bnesesito\b/g, 'necesito'],
    [/\bnecesitoo\b/g, 'necesito'],
    [/\bpodes\b/g, 'podes'],
    [/\bpodes\b/g, 'podes'],
    [/\bpodrias\b/g, 'podrias'],
    [/\bpuees\b/g, 'podes'],
    [/\btruno\b/g, 'turno'],
    [/\bturmo\b/g, 'turno'],
    [/\bturnu\b/g, 'turno'],
    [/\bturun\b/g, 'turno'],
    [/\btuno\b/g, 'turno'],
    [/\bturnitoo\b/g, 'turnito'],
    [/\bturnitto\b/g, 'turnito'],
    [/\breserba\b/g, 'reserva'],
    [/\bresrva\b/g, 'reserva'],
    [/\bresrvar\b/g, 'reservar'],
    [/\bresrvar\b/g, 'reservar'],
    [/\bresevar\b/g, 'reservar'],
    [/\bresrbar\b/g, 'reservar'],
    [/\bagendarme\b/g, 'agendar'],
    [/\bagendame\b/g, 'agendar'],
    [/\banotame\b/g, 'anotar'],
    [/\banotenme\b/g, 'anotar'],
    [/\bme anotas\b/g, 'anotar'],
    [/\bme anotan\b/g, 'anotar'],
    [/\bubiacion\b/g, 'ubicacion'],
    [/\bubicacionn\b/g, 'ubicacion'],
    [/\bdirecion\b/g, 'direccion'],
    [/\bdireccionn\b/g, 'direccion'],
    [/\bhoraro\b/g, 'horario'],
    [/\bpreicio\b/g, 'precio'],
    [/\bcnto\b/g, 'cuanto'],
    [/\bke\b/g, 'que'],
    [/\bq\b/g, 'que'],
    [/\bxq\b/g, 'porque'],
    [/\bpq\b/g, 'porque'],
    [/\btmb\b/g, 'tambien'],
    [/\bxfa\b/g, 'por favor'],
    [/\bpls\b/g, 'por favor'],
    [/\bporfa\b/g, 'por favor'],
    [/\bporfis\b/g, 'por favor'],
    [/\bmananaa\b/g, 'manana'],
    [/\bmanan\b/g, 'manana'],
    [/\btardee\b/g, 'tarde'],
    [/\bfransisco\b/g, 'francisco'],
    [/\bfrancico\b/g, 'francisco'],
    [/\bfranciscoo\b/g, 'francisco'],
    [/\bjavie\b/g, 'javier'],
    [/\bjavierr\b/g, 'javier'],
    [/\bquiropractica\b/g, 'quiropraxia'],
    [/\bquiropractia\b/g, 'quiropraxia'],
    [/\bquiropraxiaa\b/g, 'quiropraxia'],
    [/\bmasajee\b/g, 'masaje'],
    [/\bmasae\b/g, 'masaje'],
    [/\bmsaje\b/g, 'masaje'],
    [/\bobrasocial\b/g, 'obra social'],
    [/\bprepa\b/g, 'prepaga'],
    [/\bmercadopago\b/g, 'mercado pago'],
    [/\bmp\b/g, 'mercado pago'],
    [/\bxfer\b/g, 'transferencia'],
    [/\bxferencia\b/g, 'transferencia'],
    [/\btransf\b/g, 'transferencia'],
    [/\befect\b/g, 'efectivo'],
    [/\befective\b/g, 'efectivo'],
  ];

  for (const [re, to] of fixes) {
    t = t.replace(re, to);
  }

  return t.replace(/\s+/g, ' ').trim();
}

export function matchesLoosely(text: string, target: string): boolean {
  const normalizedText = normalizeHumanText(text).replace(/quiropractica/g, 'quiropraxia');
  const normalizedTarget = normalizeHumanText(target).replace(/quiropractica/g, 'quiropraxia');
  if (normalizedText.includes(normalizedTarget) || normalizedTarget.includes(normalizedText)) {
    return true;
  }

  // Match por tokens con typo (francisco ≈ fransisco)
  const textWords = normalizedText.split(/\s+/);
  const targetWords = normalizedTarget.split(/\s+/).filter(w => w.length >= 3);
  if (targetWords.length === 0) return false;

  return targetWords.every(tw =>
    textWords.some(w => w.includes(tw) || tw.includes(w) || wordsClose(w, tw, 2))
  );
}

const BOOKING_PHRASES = [
  'reservar',
  'reserva',
  'reservame',
  'reservarme',
  'quiero reservar',
  'necesito reservar',
  'turno',
  'turnito',
  'turnitos',
  'turnos',
  'cita',
  'citas',
  'agendar',
  'agenda',
  'agendame',
  'agendarme',
  'anotar',
  'anotame',
  'anotenme',
  'sacar turno',
  'sacar un turno',
  'pedir turno',
  'pedir un turno',
  'quiero turno',
  'quiero un turno',
  'necesito turno',
  'necesito un turno',
  'busco turno',
  'busco un turno',
  'un turno',
  'hay turno',
  'hay turnos',
  'hay lugar',
  'hay disponible',
  'hay disponibilidad',
  'tenes disponible',
  'tienes disponible',
  'tienen disponible',
  'esta disponible',
  'disponibilidad',
  'tienen lugar',
  'tienen turno',
  'tienen turnos',
  'tienes turno',
  'tienes turnos',
  'tenes turno',
  'tenes turnos',
  'tenes para',
  'tienes para',
  'tienen para',
  'hay para',
  'lugar para',
  'dame turno',
  'dame un turno',
  'pasame turno',
  'pasame un turno',
  'me anotas',
  'me anotan',
  'me agend',
  'me agendan',
  'me agendas',
  'consigo turno',
  'consigo un turno',
  'puedo sacar',
  'puedo pedir',
  'quiero ir',
  'quiero atender',
  'quiero atenderme',
  'para atenderme',
  'para la quiropraxia',
  'para el masaje',
  'para masaje',
  'para quiropraxia',
];

const WANT_WORDS = [
  'quiero',
  'queria',
  'quisiera',
  'necesito',
  'busco',
  'pido',
  'dame',
  'podes',
  'podrias',
  'pueden',
  'tenes',
  'tienes',
  'tienen',
  'habra',
  'habra',
  'hay',
];

const BOOKING_WORDS = [
  'turno',
  'turnito',
  'turnos',
  'cita',
  'citas',
  'reserva',
  'reservar',
  'agenda',
  'agendar',
  'lugar',
  'horario',
  'disponible',
  'disponibilidad',
  'cupo',
  'libre',
];

/** Preguntas de cupo sin decir "turno": "tenés disponible para el 20?" */
/** Pregunta por horario de atención (no pedir cupo/reservar). */
export function isClinicScheduleQuestion(text: string): boolean {
  const n = normalizeHumanText(text);
  if (!n) return false;
  if (/\ba\s+partir\s+de\s+(que\s+)?hora/.test(n)) return true;
  if (/\bdesde\s+que\s+hora\b/.test(n)) return true;
  if (/\b(a\s+)?que\s+hora\b/.test(n) && /\b(abren|abre|atienden|atiende|empiezan|empieza|comienzan|comienza|arranca)\b/.test(n)) {
    return true;
  }
  if (/\bhorario\s+de\s+atencion\b/.test(n)) return true;
  if (/\b(comienza|empieza|arranca)\b/.test(n) && /\b(atender|atencion|horario)\b/.test(n)) {
    return true;
  }
  return false;
}

export function looksLikeAvailabilityQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  if (
    /\b(disponible|disponibilidad|cupo|libre|lugar)\b/.test(normalized) &&
    /\b(tenes|tienes|tienen|hay|habra|podes|podrias|esta|estan|para)\b/.test(normalized)
  ) {
    return true;
  }
  // "Tienes turno para las 11…", "tenés para mañana", "hay turno a las 15"
  if (/\b(tenes|tienes|tienen|hay)\s+(turno|turnos|para)\b/.test(normalized)) return true;
  if (/\b(tenes|tienes|tienen|hay)\s+para\b/.test(normalized)) return true;
  return false;
}

export function containsBookingIntent(text: string): boolean {
  // Estado del turno propio ≠ pedir uno nuevo ("cuánto falta para el turno")
  if (isMisReservasIntent(text)) return false;

  const normalized = normalizeHumanText(text);

  if (includesAny(normalized, BOOKING_PHRASES)) return true;
  if (looksLikeAvailabilityQuestion(text)) return true;

  // Typos sueltos: "truno", "turmo", "resevar"
  if (hasWordCloseTo(normalized, ['turno', 'turnito', 'cita', 'reserva', 'reservar', 'agendar'], 2)) {
    if (
      hasWordCloseTo(normalized, WANT_WORDS, 1) ||
      includesAny(normalized, ['un ', 'sacar', 'pedir', 'hay', 'tienen', 'hola', 'buenas'])
    ) {
      return true;
    }
  }

  const wants = WANT_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(normalized));
  const books = BOOKING_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(normalized));
  if (wants && books) return true;

  // "me anotas / anotame / agendame" sin decir "turno"
  if (/\b(anotame|anotar|agendame|agendar|reservame)\b/.test(normalized)) return true;

  return false;
}

export function looksLikeQuestion(text: string): boolean {
  if (containsBookingIntent(text)) return false;

  const normalized = normalizeHumanText(text);
  const questionSignals = [
    '?',
    'queria saber',
    'quiero saber',
    'quisiera saber',
    'me podes',
    'podes decir',
    'podrias decir',
    'reciben',
    'aceptan',
    'obra social',
    'prepaga',
    'horario',
    'cuanto',
    'precio',
    'cuesta',
    'donde',
    'ubicacion',
    'informacion',
    'consulta',
    'pago',
    'efectivo',
    'transferencia',
    'mercado pago',
    'cancelar turno',
    'politica',
    'que traigo',
    'que llevar',
    'ropa',
    'estacionamiento',
    'estacionar',
    'parking',
    'cuanto dura',
    'duracion',
    'info',
    'informen',
    'averiguar',
  ];
  return questionSignals.some(signal => normalized.includes(normalizeHumanText(signal)));
}

function matchesInfoGroup(normalized: string, phrases: string[], fuzzyWords?: string[]): boolean {
  if (includesAny(normalized, phrases.map(p => normalizeHumanText(p)))) return true;
  if (fuzzyWords && hasWordCloseTo(normalized, fuzzyWords, 2)) return true;
  return false;
}

export function parseInfoQuery(text: string): InfoQueryType | null {
  // Preguntas sobre EL turno del paciente → no FAQ genérica
  if (isMisReservasIntent(text)) return null;

  const normalized = normalizeHumanText(text);

  if (
    matchesInfoGroup(normalized, [
      'obra social',
      'obras sociales',
      'prepaga',
      'prepagas',
      'osde',
      'swiss medical',
      'galeno',
      'medicus',
      'cobertura',
      'mutual',
      'particular o obra',
      'aceptan obra',
      'reciben obra',
      'trabajan con obra',
    ])
  ) {
    return 'obra_social';
  }

  if (
    matchesInfoGroup(
      normalized,
      [
        'ubicacion',
        'direccion',
        'como llego',
        'como llegar',
        'mapa',
        'donde quedan',
        'donde estan',
        'donde queda',
        'donde es',
        'donde queda eso',
        'donde se encuentra',
        'donde se encuentran',
        'donde esta la',
        'donde esta el',
        'en que calle',
        'ubicados',
        'domicilio',
        'donde van',
        'donde atienden',
        'donde queda la clinica',
        'donde queda el consultorio',
        'lugar fisico',
        'dire',
      ],
      ['ubicacion', 'direccion', 'domicilio']
    )
  ) {
    return 'ubicacion';
  }

  if (
    matchesInfoGroup(normalized, [
      'estacionamiento',
      'estacionar',
      'parking',
      'donde dejo el auto',
      'donde estaciono',
      'hay cochera',
      'cochera',
      'garage',
      'donde dejo el auto',
      'puedo estacionar',
    ])
  ) {
    return 'estacionamiento';
  }

  if (
    matchesInfoGroup(normalized, [
      'forma de pago',
      'formas de pago',
      'como pago',
      'como se paga',
      'medios de pago',
      'con que pagan',
      'con que se paga',
      'efectivo',
      'transferencia',
      'mercado pago',
      'tarjeta',
      'debito',
      'credito',
      'alias',
      'cbu',
      'puedo pagar',
      'aceptan tarjeta',
      'aceptan transferencia',
    ]) ||
    (normalized.includes('pago') && !normalized.includes('prepago') && !normalized.includes('prepaga'))
  ) {
    return 'pago';
  }

  if (
    matchesInfoGroup(normalized, [
      'cancelar turno',
      'cancelo',
      'cancelacion',
      'politica de cancel',
      'con cuanta anticipacion',
      'avisar si no voy',
      'si no puedo ir',
      'reagendar',
      'reprogramar',
      'cambiar turno',
      'mover turno',
      'si falto',
      'si no llego',
      'puedo cancelar',
      'como cancelo',
    ]) ||
    (normalized.includes('cancelar') && (normalized.includes('turno') || normalized.includes('cita')))
  ) {
    return 'cancelacion';
  }

  if (
    matchesInfoGroup(normalized, [
      'que traer',
      'que llevo',
      'que llevar',
      'que me pongo',
      'ropa comoda',
      'ropa',
      'tengo que llevar',
      'debo llevar',
      'hay que llevar',
      'necesito llevar',
      'voy en short',
      'voy en jean',
      'que me pongo',
      'outfit',
    ])
  ) {
    return 'que_traer';
  }

  if (
    matchesInfoGroup(normalized, [
      'cuanto dura',
      'cuanto tarda',
      'duracion',
      'cuanto tiempo dura',
      'minutos dura',
      'cuanto demora',
      'cuanto lleva',
      'es largo',
      'cuanto es la sesion',
    ])
  ) {
    return 'duracion';
  }

  if (
    matchesInfoGroup(
      normalized,
      [
        'horario',
        'horarios',
        'abren',
        'cierran',
        'cuando atiende',
        'cuando atienden',
        'a que hora',
        'en que horario',
        'que dias',
        'que dia atienden',
        'abierto',
        'estan abiertos',
        'hasta que hora',
        'de que hora',
      ],
      ['horario', 'horarios']
    )
  ) {
    return 'horarios';
  }

  if (
    matchesInfoGroup(
      normalized,
      [
        'precio',
        'precios',
        'cuesta',
        'cuanto sale',
        'cuanto sale',
        'valor',
        'costo',
        'tarifa',
        'tarifas',
        'cuanto cobr',
        'cuanto sale el',
        'cuanto esta',
        'cuanto sale',
        'lista de precios',
        'valores',
      ],
      ['precio', 'precios', 'tarifa', 'costo']
    ) ||
    /\bcuanto\b/.test(normalized)
  ) {
    // "cuanto" solo → precios, salvo si ya matcheó otra cosa arriba
    return 'precios';
  }

  return null;
}

/**
 * Extrae profesional/servicio/fecha/franja/hora de un pedido natural,
 * p.ej. "reservar con Francisco mañana a la tarde".
 */
export function extractBookingParameters(
  text: string,
  profesionales: string[],
  servicios: Array<{ nombre: string }>
): NonNullable<BotIntent['parameters']> {
  const normalized = normalizeHumanText(text);
  const params: NonNullable<BotIntent['parameters']> = {};

  const sortedProfs = [...profesionales].sort((a, b) => b.length - a.length);
  for (const prof of sortedProfs) {
    const tokens = normalizeHumanText(prof).split(' ').filter(t => t.length >= 3);
    const firstName = tokens[0];
    if (matchesLoosely(text, prof)) {
      params.profesional = prof;
      break;
    }
    if (firstName && (new RegExp(`\\b${firstName}\\b`).test(normalized) || hasWordCloseTo(normalized, [firstName], 2))) {
      params.profesional = prof;
      break;
    }
  }

  const sortedServs = [...servicios].sort((a, b) => b.nombre.length - a.nombre.length);
  for (const serv of sortedServs) {
    const nameNorm = normalizeHumanText(serv.nombre);
    if (normalized.includes(nameNorm) || matchesLoosely(text, serv.nombre)) {
      params.servicio = serv.nombre;
      break;
    }
    if (nameNorm.includes('quiropraxia') && (/\bquiroprax/.test(normalized) || hasWordCloseTo(normalized, ['quiropraxia', 'quiro'], 2))) {
      params.servicio = serv.nombre;
      break;
    }
    if (nameNorm.includes('masaje') && (/\bmasaje\b/.test(normalized) || hasWordCloseTo(normalized, ['masaje', 'masajito'], 2))) {
      params.servicio = serv.nombre;
      break;
    }
    if (nameNorm.includes('premium') && (/\bpremium\b/.test(normalized) || hasWordCloseTo(normalized, ['premium'], 2))) {
      params.servicio = serv.nombre;
      break;
    }
  }

  const hasPorLaManana = /por\s+la\s+manana|a\s+la\s+manana|de\s+manana|x\s+la\s+manana/.test(normalized);
  const hasPorLaTarde = /por\s+la\s+tarde|a\s+la\s+tarde|de\s+tarde|x\s+la\s+tarde/.test(normalized);
  if (hasPorLaTarde || (/\btarde\b/.test(normalized) && !hasPorLaManana)) {
    params.franja = 'tarde';
  } else if (hasPorLaManana) {
    params.franja = 'manana';
  }

  const today = getToday();
  if (/pasado\s+manana|pasadomanana/.test(normalized)) {
    params.fecha = toDateStr(addDays(today, 2));
  } else if (/\bmanana\b/.test(normalized) && !hasPorLaManana) {
    params.fecha = toDateStr(addDays(today, 1));
  } else if (/\bhoy\b|\bahora\b/.test(normalized)) {
    params.fecha = toDateStr(today);
  } else {
    const slash = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
    if (slash) {
      const parsed = parseFecha(slash[0]);
      if (parsed) params.fecha = parsed;
    }
  }

  const horas = extractHoraCandidates(text);
  if (horas.length === 1) {
    params.hora = horas[0];
  }

  return params;
}

const NAME_STOPWORDS = new Set([
  'si',
  'sí',
  'no',
  'ok',
  'okay',
  'dale',
  'listo',
  'bueno',
  'va',
  'yes',
  'nop',
  'nope',
  'cancelar',
  'confirmar',
  'confirmo',
  'menu',
  'menú',
  'hola',
  'buenas',
  'gracias',
  'por favor',
  'nombre',
  'mi nombre',
]);

export function isValidPersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (trimmed.split(/\s+/).length > 4) return false;
  if (/\d/.test(trimmed)) return false;
  if (!/^[\p{L}\s'.-]+$/u.test(trimmed)) return false;

  const normalized = normalizeHumanText(trimmed);
  if (normalized === 'undefined' || normalized === 'null') return false;
  if (NAME_STOPWORDS.has(normalized)) return false;
  if (normalized.split(' ').every(w => NAME_STOPWORDS.has(w))) return false;

  return true;
}

/**
 * Extrae un nombre usable de respuestas naturales:
 * "Salvador", "me llamo Salvador", "Salvador es mi nombre", "soy María López".
 */
export function extractPersonName(text: string): string | undefined {
  const trimmed = text.trim().replace(/^[*_~`]+|[*_~`]+$/g, '');
  if (!trimmed) return undefined;

  // Frases primero (si no, "Salvador es mi nombre" pasa isValidPersonName entero)
  const patterns = [
    /(?:^|\b)(?:me llamo|mi nombre es|soy)\s+(.+)$/i,
    /^(.+?)\s+es mi nombre\.?$/i,
    /^(.+?)\s+mi nombre\.?$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && isValidPersonName(candidate)) return candidate;
  }

  if (isValidPersonName(trimmed)) return trimmed;
  return undefined;
}

/** Nombre usable para reserva (rechaza vacío / "undefined" de bugs previos). */
export function sanitizePersonName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return extractPersonName(trimmed);
}

/** El usuario abandona el armado de un turno nuevo (no confundir con cancelar un turno ya reservado). */
export function isAbortBookingIntent(text: string): boolean {
  const n = normalizeHumanText(text);
  if (!n) return false;

  if (
    [
      'cancelar',
      'cancel',
      'salir',
      'olvidate',
      'olvidalo',
      'dejalo',
      'dejala',
      'basta',
      'mejor no',
      'al final no',
      'no gracias',
      'nop',
      'nope',
    ].includes(n)
  ) {
    return true;
  }

  if (/\bno\s+(voy\s+a\s+)?reserv/.test(n)) return true;
  if (/\bno\s+quiero\s+(reserv|seguir|continuar|agendar|turno)/.test(n)) return true;
  if (/\bno\s+sigamos\b/.test(n)) return true;
  if (/\bal\s+final\s+no\b/.test(n)) return true;
  if (/\bmejor\s+no\b/.test(n)) return true;
  if (/\b(cancel|anul)\w*\b/.test(n) && /\b(reserva|reservar|turno|cita|flujo|esto)\b/.test(n)) {
    // "cancelar mi turno" (ya reservado) lo maneja misreservas; acá es abortar el armado
    if (/\b(mi|el)\s+turno\b/.test(n) && !/\b(reservar|reserva|armando|sacando)\b/.test(n)) {
      return false;
    }
    return true;
  }

  return false;
}

export function isValidFlowInput(text: string, paso: string): boolean {
  const trimmed = text.trim();

  if (isAbortBookingIntent(trimmed)) return false;

  // "Tienes para hoy?" es pregunta PERO es input válido de fecha
  if (paso === 'fecha') {
    return parseFecha(trimmed) !== null;
  }

  if (looksLikeQuestion(text)) return false;

  switch (paso) {
    case 'nombre':
      return Boolean(extractPersonName(trimmed));
    case 'hora':
      return looksLikeHoraInput(trimmed);
    case 'profesional':
    case 'servicio':
      return trimmed.length > 0;
    case 'confirmar':
      return false;
    default:
      return false;
  }
}

export type MisReservasMode = 'status' | 'change' | 'cancel';

/** Preguntas sobre el estado del turno propio (antes que FAQ / consulta). */
export function isMisReservasIntent(text: string): boolean {
  const normalized = normalizeHumanText(text);
  if (!normalized) return false;

  if (normalized === 'reservas' || normalized === 'turnos') return true;

  if (
    matchesInfoGroup(normalized, [
      'mis reservas',
      'mis turnos',
      'mi reserva',
      'mi turno',
      'ver reservas',
      'ver turnos',
      'mis citas',
      'que turnos tengo',
      'que turno tengo',
      'cuando es mi turno',
      'cuando tengo turno',
      'cuando es mi cita',
      'a que hora es mi turno',
      'a que hora tengo turno',
      'que dia es mi turno',
      'que dia tengo turno',
      'tenes mi turno',
      'tenes el turno',
      'tengo turno',
      'tengo un turno',
      'ya tengo turno',
      'ya reserve',
      'ya reserve turno',
      'estado de mi turno',
      'estado del turno',
      'confirmar mi turno',
      'recordame el turno',
      'recordame mi turno',
      'cual es mi turno',
      'decime mi turno',
      'mostrame mi turno',
      'mostrame mis turnos',
      'cambiar mi turno',
      'cambiar el turno',
      'puedo cambiar mi turno',
      'quiero cambiar mi turno',
      'necesito cambiar mi turno',
      'pasame el turno',
      'pasame mi turno',
      'pasar el turno',
      'pasar mi turno',
      'cancelar mi turno',
      'cancelar el turno',
      'quiero cancelar mi turno',
      'puedo cancelar mi turno',
      'mover mi turno',
      'reprogramar mi turno',
      'reagendar mi turno',
      'cuanto falta',
      'cuanto falta para el turno',
      'cuanto falta para mi turno',
      'falta para el turno',
      'falta para mi turno',
      'falta mucho para el turno',
      'en cuanto es el turno',
      'en cuanto es mi turno',
    ])
  ) {
    return true;
  }

  // Patrones sueltos: "tengo algo agendado?", "para cuando es?", "lo quiero cambiar"
  if (
    /\b(mi|mis)\s+(turno|turnos|reserva|reservas|cita|citas)\b/.test(normalized) ||
    /\bcuando\s+(es|tengo|queda|seria)\b.*\b(turno|cita|reserva)\b/.test(normalized) ||
    /\b(turno|cita|reserva)\b.*\bcuando\b/.test(normalized) ||
    /\ba\s+que\s+hora\b.*\b(mi\s+)?(turno|cita)\b/.test(normalized) ||
    /\bque\s+dia\b.*\b(mi\s+)?(turno|cita)\b/.test(normalized) ||
    /\b(ya\s+)?(reserve|agende|anote)\b/.test(normalized) ||
    /\bme\s+acordas\b.*\b(turno|cita|reserva)\b/.test(normalized) ||
    /\b(cambiar|reprogramar|reagendar|mover|pasar|pasame)\b.*\b(turno|cita|reserva)\b/.test(
      normalized
    ) ||
    /\b(turno|cita|reserva)\b.*\b(cambiar|reprogramar|reagendar|mover)\b/.test(normalized) ||
    /\b(cancelar|anular)\b.*\b(turno|cita|reserva)\b/.test(normalized) ||
    /\bcuanto\s+falta\b/.test(normalized) ||
    /\bfalta\b.*\b(turno|cita|reserva)\b/.test(normalized) ||
    /\b(turno|cita|reserva)\b.*\bfalta\b/.test(normalized)
  ) {
    return true;
  }

  return false;
}

/** "¿Cuánto falta?" / tiempo restante hasta el turno propio. */
export function isTimeUntilIntent(text: string): boolean {
  const n = normalizeHumanText(text);
  if (!n) return false;
  if (/\bcuanto\s+falta\b/.test(n)) return true;
  if (/\bfalta\b/.test(n) && /\b(turno|cita|reserva|para)\b/.test(n)) return true;
  if (/\ben\s+cuanto\b/.test(n)) return true;
  // Seguimiento corto después de ver el turno: "cuanto falta?"
  if (n === 'cuanto falta' || n === 'y cuanto falta' || n === 'cuanto falta exactamente') {
    return true;
  }
  return false;
}

/**
 * Dentro de mis reservas: ¿solo consultar, cambiar o cancelar?
 * "cambiar o cancelar" → status (mostrar ambos).
 */
export function getMisReservasMode(text: string): MisReservasMode {
  const n = normalizeHumanText(text);
  const wantsCancel =
    /\b(cancel|anul|borrar)\w*\b/.test(n) &&
    (/\b(turno|cita|reserva)\b/.test(n) || /\bmi\b/.test(n));
  const wantsChange =
    /\b(cambi|reprogram|reagend|mover|pasame|pasar)\w*\b/.test(n) &&
    (/\b(turno|cita|reserva|fecha|dia|horario|hora)\b/.test(n) ||
      /\b(otro|otra|para)\b/.test(n) ||
      /\bpuedo\b/.test(n) ||
      /\bquiero\b/.test(n) ||
      /\bnecesito\b/.test(n));

  if (wantsCancel && wantsChange) return 'status';
  if (wantsCancel) return 'cancel';
  if (wantsChange) return 'change';
  return 'status';
}

/** Saludo / reset de charla (no consulta de clínica ni pedido de turno). */
export function isGreetingOrChatReset(text: string): boolean {
  const normalized = normalizeHumanText(text);
  if (!normalized) return false;
  if (containsBookingIntent(text)) return false;
  if (parseInfoQuery(text)) return false;

  if (
    /^(menu|menú|\/start|start|reiniciar|reset|limpiar|borrar)\b/.test(normalized) ||
    normalized.includes('empezar de nuevo') ||
    normalized.includes('borrar chat') ||
    normalized.includes('reiniciar chat') ||
    normalized.includes('reset chat')
  ) {
    return true;
  }

  if (
    /^(hola|buenas|buen dia|hey|holis|hello|hi)(\s|$)/.test(normalized) ||
    /^(como estas|como andas|que tal|todo bien)(\?|$)/.test(normalized)
  ) {
    // "hola quiero saber horarios" ya quedó afuera por parseInfoQuery / booking
    return true;
  }

  return false;
}

/** Solo menú explícito (no cada "hola"). */
export function isExplicitMenuCommand(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    normalized === '/start' ||
    normalized === 'start' ||
    normalized === 'menu' ||
    normalized === 'menú' ||
    normalized === 'reiniciar' ||
    normalized === 'reset' ||
    normalized.includes('boton') ||
    normalized.includes('botones') ||
    normalized.includes('ayuda') ||
    normalized.includes('inicio') ||
    normalized.includes('empezar') ||
    normalized.includes('opciones') ||
    normalized.includes('empezar de nuevo') ||
    normalized.includes('borrar chat') ||
    normalized.includes('reiniciar chat')
  );
}

export function parseLocalIntent(text: string): BotIntent | null {
  const normalized = normalizeHumanText(text);

  // Estado del turno propio antes que FAQ ("a qué hora…") o pedir turno
  if (isMisReservasIntent(text)) {
    return { action: 'misreservas' };
  }

  // Saludos antes que "consulta" por el "?" ("buenas, como estas?")
  if (isGreetingOrChatReset(text)) {
    return { action: 'menu' }; // webhook: reset + Gemini (menú explícito aparte)
  }

  // Profesionales / doctores primero (antes que "atienden" u otras señales)
  if (
    matchesInfoGroup(
      normalized,
      [
        'profesional',
        'profesionales',
        'doctor',
        'doctora',
        'doctores',
        'medico',
        'medicos',
        'especialista',
        'especialistas',
        'quiropractico',
        'quiropraxista',
        'quien atiende',
        'quienes atienden',
        'con quien',
        'con quien atiende',
        'que doctores',
        'que profesionales',
        'que medicos',
        'lista de doctores',
        'quienes son',
        'el staff',
      ],
      ['profesional', 'doctor', 'medico', 'especialista']
    )
  ) {
    // Si pide turno con profesional ("turno con el doctor") → reservar gana abajo;
    // acá solo catálogo cuando NO hay booking claro sin "con X".
    if (!containsBookingIntent(text)) {
      return { action: 'profesionales' };
    }
  }

  // Catálogo de servicios
  if (
    !containsBookingIntent(text) &&
    matchesInfoGroup(normalized, [
      'servicio',
      'servicios',
      'sesiones',
      'que ofrecen',
      'tipos de sesion',
      'que hacen',
      'que tratamientos',
      'catalogo',
      'opciones de sesion',
    ])
  ) {
    return { action: 'servicios' };
  }

  if (
    !containsBookingIntent(text) &&
    normalized.includes('mostr') &&
    (normalized.includes('sesion') || normalized.includes('precio') || normalized.includes('opcion'))
  ) {
    return { action: 'servicios' };
  }

  if (parseInfoQuery(text) && !containsBookingIntent(text)) {
    return { action: 'consulta' };
  }

  if (looksLikeQuestion(text) && !containsBookingIntent(text)) {
    return { action: 'consulta' };
  }

  // Pedido de turno gana a saludos ("hola quiero turno")
  if (containsBookingIntent(text)) {
    return { action: 'reservar' };
  }

  if (isExplicitMenuCommand(text)) {
    return { action: 'menu' };
  }

  return null;
}
