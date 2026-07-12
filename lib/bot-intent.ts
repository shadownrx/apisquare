import { parseFecha } from './parse-fecha';

export interface BotIntent {
  action: 'menu' | 'reservar' | 'misreservas' | 'servicios' | 'profesionales' | 'consulta' | 'unknown';
  parameters?: {
    profesional?: string;
    servicio?: string;
    fecha?: string;
    nombre?: string;
  };
}

export function normalizeHumanText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s:?]/gu, ' ')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesLoosely(text: string, target: string): boolean {
  const normalizedText = normalizeHumanText(text).replace(/quiropractica/g, 'quiropraxia');
  const normalizedTarget = normalizeHumanText(target).replace(/quiropractica/g, 'quiropraxia');
  return normalizedText.includes(normalizedTarget) || normalizedTarget.includes(normalizedText);
}

export function containsBookingIntent(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const bookingSignals = [
    'reservar',
    'reserva',
    'turno',
    'turnito',
    'cita',
    'agendar',
    'agenda',
    'sacar turno',
    'pedir turno',
    'quiero turno',
    'necesito turno',
    'un turno',
    'hay turno',
    'dame turno',
    'me anotas',
    'me agend',
  ];

  if (bookingSignals.some(signal => normalized.includes(signal))) {
    return true;
  }

  return /\b(quiero|qiero|kiero|necesito|busco|pido|dame|podes)\b/.test(normalized) &&
    /\b(turno|turnito|cita|reserva)\b/.test(normalized);
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
    'me podés',
    'podes decir',
    'podés decir',
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
  ];
  return questionSignals.some(signal => normalized.includes(normalizeHumanText(signal)));
}

export function parseInfoQuery(text: string): 'obra_social' | 'horarios' | 'precios' | null {
  const normalized = normalizeHumanText(text);

  if (
    normalized.includes('obra social') ||
    normalized.includes('prepaga') ||
    normalized.includes('osde') ||
    normalized.includes('swiss medical') ||
    normalized.includes('galeno') ||
    normalized.includes('medicus')
  ) {
    return 'obra_social';
  }

  if (
    normalized.includes('horario') ||
    normalized.includes('atienden') ||
    normalized.includes('abren') ||
    normalized.includes('cierran') ||
    normalized.includes('cuando atiende')
  ) {
    return 'horarios';
  }

  if (
    normalized.includes('precio') ||
    normalized.includes('cuesta') ||
    normalized.includes('cuanto sale') ||
    normalized.includes('valor') ||
    normalized.includes('costo') ||
    normalized.includes('tarifa')
  ) {
    return 'precios';
  }

  return null;
}

export function isValidFlowInput(text: string, paso: string): boolean {
  if (looksLikeQuestion(text)) return false;

  const trimmed = text.trim();

  switch (paso) {
    case 'nombre':
      return trimmed.length >= 2 && trimmed.length <= 40 && trimmed.split(/\s+/).length <= 4;
    case 'fecha':
      return parseFecha(text) !== null;
    case 'hora':
      return /^\d{1,2}(:\d{2})?$/.test(trimmed);
    case 'profesional':
    case 'servicio':
      return trimmed.length > 0;
    case 'confirmar':
      return false;
    default:
      return false;
  }
}

export function parseLocalIntent(text: string): BotIntent | null {
  const normalized = normalizeHumanText(text);

  if (parseInfoQuery(text)) {
    return { action: 'consulta' };
  }

  if (looksLikeQuestion(text)) {
    return { action: 'consulta' };
  }

  if (
    normalized === '/start' ||
    normalized === 'start' ||
    normalized === 'menu' ||
    normalized.includes('boton') ||
    normalized.includes('ayuda') ||
    normalized.includes('inicio')
  ) {
    return { action: 'menu' };
  }

  if (
    normalized === 'hola' ||
    normalized === 'buenas' ||
    normalized === 'buen dia' ||
    normalized.startsWith('hola ') ||
    normalized.startsWith('buenas ')
  ) {
    return { action: 'menu' };
  }

  if (normalized.includes('mis reservas') || normalized === 'reservas') {
    return { action: 'misreservas' };
  }

  if (containsBookingIntent(text)) {
    return { action: 'reservar' };
  }

  if (normalized.includes('servicio')) {
    return { action: 'servicios' };
  }

  if (normalized.includes('profesional')) {
    return { action: 'profesionales' };
  }

  return null;
}
