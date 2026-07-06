const fs = require('fs');
const path = require('path');

const routePath = path.join(__dirname, 'app', 'api', 'webhook', 'route.ts');
let content = fs.readFileSync(routePath, 'utf8');

// 1. Interfaces
content = content.replace(
`interface ConversationState {
  paso?: string | null;
  servicio?: string;
  nombre?: string;
  fecha?: string;
  hora?: string; // guardamos la hora elegida para el paso de confirmación
}

interface Reservation {
  id: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}`,
`interface ConversationState {
  paso?: string | null;
  profesional?: string;
  servicio?: string;
  nombre?: string;
  fecha?: string;
  hora?: string; // guardamos la hora elegida para el paso de confirmación
}

interface Reservation {
  id: string;
  profesional: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}`
);

// 2. Constants
content = content.replace(
`// Lista de servicios disponibles
const servicios = [
  'Sesión de Quiropráctica',
  'Masaje Relajante',
  'Traumatología'
];

// Horarios disponibles (Lunes a Viernes de 9:00 a 18:00, turnos de 60 min)
const horariosDisponibles = [
  '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00'
];
const diasLaborables = [1, 2, 3, 4, 5]; // Lunes (1) a Viernes (5)`,
`// Profesionales y Servicios
const PROFESIONALES = ['Francisco Chibilisco', 'Javier Martoni'];

const SERVICIOS = [
  { nombre: 'Sesión de Quiropraxia', duracionMinutos: 25, precio: 30000 },
  { nombre: 'Sesión de Masajes', duracionMinutos: 45, precio: 30000 },
  { nombre: 'Sesión Premium', duracionMinutos: 60, precio: 55000 }
];

function getServicio(nombre: string) {
  return SERVICIOS.find(s => s.nombre.toLowerCase() === nombre.toLowerCase());
}

// Devuelve { inicio, fin } para un profesional y día (0=Dom, 1=Lun, ..., 6=Sab)
function getHorarioProfesional(profesional: string, dia: number): { inicio: string, fin: string } | null {
  if (profesional === 'Francisco Chibilisco') {
    if (dia >= 1 && dia <= 3) return { inicio: '11:00', fin: '13:00' };
    if (dia === 4 || dia === 5) return { inicio: '15:00', fin: '20:00' };
    if (dia === 6) return { inicio: '09:00', fin: '13:00' };
    return null;
  }
  if (profesional === 'Javier Martoni') {
    if (dia >= 1 && dia <= 5) return { inicio: '15:30', fin: '20:00' };
    return null;
  }
  return null;
}

function esDiaLaborable(fechaStr: string, profesional?: string): boolean {
  if (!profesional) return true;
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  return getHorarioProfesional(profesional, dia) !== null;
}`
);

// 3. Update proximosDiasLaborables
content = content.replace(
`function proximosDiasLaborables(cantidad: number): { fecha: string; label: string }[] {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  let offset = 0;

  while (dias.length < cantidad && offset < 30) {
    const candidate = addDays(today, offset);
    if (diasLaborables.includes(candidate.getDay())) {
      let label: string;
      if (offset === 0) {
        label = 'Hoy';
      } else if (offset === 1) {
        label = 'Mañana';
      } else {
        // Ej: "Lun 07 Jul"
        const weekday = candidate.toLocaleDateString('es-ES', { weekday: 'short' });
        const day = candidate.getDate();
        const month = candidate.toLocaleDateString('es-ES', { month: 'short' });
        label = \`\${weekday.charAt(0).toUpperCase() + weekday.slice(1)} \${day} \${month.charAt(0).toUpperCase() + month.slice(1)}\`;
      }
      dias.push({ fecha: toDateStr(candidate), label });
    }
    offset++;
  }
  return dias;
}`,
`function proximosDiasLaborables(cantidad: number, profesional?: string): { fecha: string; label: string }[] {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  let offset = 0;

  while (dias.length < cantidad && offset < 30) {
    const candidate = addDays(today, offset);
    const day = candidate.getDay();
    const works = profesional ? (getHorarioProfesional(profesional, day) !== null) : (day >= 1 && day <= 6);
    
    if (works) {
      let label: string;
      if (offset === 0) {
        label = 'Hoy';
      } else if (offset === 1) {
        label = 'Mañana';
      } else {
        const weekday = candidate.toLocaleDateString('es-ES', { weekday: 'short' });
        const d = candidate.getDate();
        const month = candidate.toLocaleDateString('es-ES', { month: 'short' });
        label = \`\${weekday.charAt(0).toUpperCase() + weekday.slice(1)} \${d} \${month.charAt(0).toUpperCase() + month.slice(1)}\`;
      }
      dias.push({ fecha: toDateStr(candidate), label });
    }
    offset++;
  }
  return dias;
}`
);

// 4. Update buildFechasKeyboard
content = content.replace(
`function buildFechasKeyboard() {
  const dias = proximosDiasLaborables(8);
  const keyboard = [];
  for (let i = 0; i < dias.length; i += 2) {
    keyboard.push(
      dias.slice(i, i + 2).map(d => ({
        text: d.label,
        callback_data: \`fecha:\${d.fecha}\`
      }))
    );
  }
  keyboard.push([{ text: '🏠 Menú principal', callback_data: 'menu' }]);
  return keyboard;
}

function buildFechasView(servicio?: string) {
  return {
    text: servicio
      ? \`📅 *\${servicio}*\\n\\n¿Qué día preferís?\`
      : '📅 ¿Qué día te gustaría?',
    keyboard: buildFechasKeyboard()
  };
}`,
`function buildFechasKeyboard(profesional?: string) {
  const dias = proximosDiasLaborables(8, profesional);
  const keyboard = [];
  for (let i = 0; i < dias.length; i += 2) {
    keyboard.push(
      dias.slice(i, i + 2).map(d => ({
        text: d.label,
        callback_data: \`fecha:\${d.fecha}\`
      }))
    );
  }
  keyboard.push([{ text: '🏠 Menú principal', callback_data: 'menu' }]);
  return keyboard;
}

function buildFechasView(servicio?: string, profesional?: string) {
  return {
    text: servicio
      ? \`📅 *\${servicio}*\\n\\n¿Qué día preferís?\`
      : '📅 ¿Qué día te gustaría?',
    keyboard: buildFechasKeyboard(profesional)
  };
}`
);

// 5. Update esDiaLaborable
content = content.replace(
`function esDiaLaborable(fechaStr: string): boolean {
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  return diasLaborables.includes(dia);
}`,
`// Eliminado esDiaLaborable antiguo`
);

// 6. Update Reserva Key & Slot Check
content = content.replace(
`function reservaKey(servicio: string, fechaStr: string, horaStr: string): string {
  return \`reserva:\${servicio}:\${fechaStr}:\${horaStr}\`;
}`,
`function reservaKey(profesional: string, fechaStr: string, horaStr: string): string {
  return \`reserva:\${profesional}:\${fechaStr}:\${horaStr}\`;
}`
);

content = content.replace(
`async function obtenerReservaEnSlot(servicio: string, fechaStr: string, horaStr: string): Promise<Reservation | null> {
  if (kv) {
    const data = await kv.get(reservaKey(servicio, fechaStr, horaStr));
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  }

  const localReservations = getLocalReservations();
  return localReservations.find(
    r => r.servicio === servicio && r.fecha === fechaStr && r.hora === horaStr
  ) ?? null;
}`,
`async function obtenerReservaEnSlot(profesional: string, fechaStr: string, horaStr: string): Promise<Reservation | null> {
  if (kv) {
    const data = await kv.get(reservaKey(profesional, fechaStr, horaStr));
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  }

  const localReservations = getLocalReservations();
  return localReservations.find(
    r => r.profesional === profesional && r.fecha === fechaStr && r.hora === horaStr
  ) ?? null;
}`
);

// 7. Update obtenerHorariosLibres
content = content.replace(
`async function obtenerHorariosLibres(fechaStr: string, servicio: string): Promise<string[]> {
  const libres: string[] = [];
  for (const hora of horariosDisponibles) {
    const ocupado = await obtenerReservaEnSlot(servicio, fechaStr, hora);
    if (!ocupado) libres.push(hora);
  }
  return libres;
}`,
`async function obtenerHorariosLibres(fechaStr: string, profesional: string, servicioNombre: string): Promise<string[]> {
  const libres: string[] = [];
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  const horario = getHorarioProfesional(profesional, dia);
  if (!horario) return libres;
  
  const servicio = getServicio(servicioNombre);
  if (!servicio) return libres;
  
  const [hIni, mIni] = horario.inicio.split(':').map(Number);
  const [hFin, mFin] = horario.fin.split(':').map(Number);
  let minutosActuales = hIni * 60 + mIni;
  const minutosFin = hFin * 60 + mFin;
  
  while (minutosActuales + servicio.duracionMinutos <= minutosFin) {
    const hStr = Math.floor(minutosActuales / 60).toString().padStart(2, '0');
    const mStr = (minutosActuales % 60).toString().padStart(2, '0');
    const horaStr = \`\${hStr}:\${mStr}\`;
    
    // Asumimos que el slot no está ocupado si la hora exacta de inicio está libre. 
    // Para simplificar, revisaremos que no haya reserva en esa hora exacta.
    const ocupado = await obtenerReservaEnSlot(profesional, fechaStr, horaStr);
    if (!ocupado) {
      libres.push(horaStr);
    }
    minutosActuales += servicio.duracionMinutos;
  }
  
  return libres;
}`
);

// 8. Update buildHorariosView
content = content.replace(
`async function buildHorariosView(fechaStr: string, servicio: string) {
  const horariosLibres = await obtenerHorariosLibres(fechaStr, servicio);

  if (horariosLibres.length === 0) {
    const otras = servicios.filter(s => s !== servicio);
    return {
      text:
        \`😕 No hay turnos disponibles para *\${servicio}* el \${formatDate(fechaStr)}.\\n\\n\` +
        \`Podés probar con otra especialidad o elegir otra fecha:\`,
      keyboard: [
        ...otras.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }]),
        [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }],
        [{ text: '🏠 Menú principal', callback_data: 'menu' }]
      ]
    };
  }`,
`async function buildHorariosView(fechaStr: string, servicio: string, profesional: string) {
  const horariosLibres = await obtenerHorariosLibres(fechaStr, profesional, servicio);

  if (horariosLibres.length === 0) {
    const otras = SERVICIOS.filter(s => s.nombre !== servicio);
    return {
      text:
        \`😕 No hay turnos disponibles para *\${servicio}* el \${formatDate(fechaStr)} con \${profesional}.\\n\\n\` +
        \`Podés probar con otra fecha o volver al menú:\`,
      keyboard: [
        [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }],
        [{ text: '🏠 Menú principal', callback_data: 'menu' }]
      ]
    };
  }`
);

// 9. Update buildConfirmacionView
content = content.replace(
`function buildConfirmacionView(estado: ConversationState) {
  return {
    text:
      \`✅ *Confirmá tu turno*\\n\\n\` +
      \`🩺 *Servicio:* \${estado.servicio}\\n\` +
      \`👤 *Nombre:* \${estado.nombre}\\n\` +
      \`📅 *Fecha:* \${formatDate(estado.fecha!)}\\n\` +
      \`🕐 *Hora:* \${estado.hora}\\n\\n\` +
      \`¿Confirmás la reserva?\`,`,
`function buildConfirmacionView(estado: ConversationState) {
  const serv = getServicio(estado.servicio || '');
  return {
    text:
      \`✅ *Confirmá tu turno*\\n\\n\` +
      \`👨‍⚕️ *Profesional:* \${estado.profesional}\\n\` +
      \`🩺 *Servicio:* \${estado.servicio} (\${serv ? '$'+serv.precio : ''})\\n\` +
      \`👤 *Nombre:* \${estado.nombre}\\n\` +
      \`📅 *Fecha:* \${formatDate(estado.fecha!)}\\n\` +
      \`🕐 *Hora:* \${estado.hora}\\n\\n\` +
      \`*⚠️ Importante:* La atención es particular (no se recibe obra social).\\n\\n\` +
      \`¿Confirmás la reserva?\`,`
);

// 10. Update verificarDisponibilidad
content = content.replace(
`async function verificarDisponibilidad(servicio: string, fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr + 'T12:00:00');
    const dia = fecha.getDay();

    if (!diasLaborables.includes(dia)) {
      return { disponible: false, mensaje: 'Lo siento, no atendemos ese día.' };
    }

    if (!horariosDisponibles.includes(horaStr)) {
      return { disponible: false, mensaje: 'Horario no disponible. Escogé entre: ' + horariosDisponibles.join(', ') };
    }

    const reservaExistente = await obtenerReservaEnSlot(servicio, fechaStr, horaStr);`,
`async function verificarDisponibilidad(profesional: string, servicio: string, fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr + 'T12:00:00');
    const dia = fecha.getDay();

    if (getHorarioProfesional(profesional, dia) === null) {
      return { disponible: false, mensaje: 'El profesional no atiende ese día.' };
    }

    const reservaExistente = await obtenerReservaEnSlot(profesional, fechaStr, horaStr);`
);
content = content.replace(
`    if (reservaExistente) {
      return {
        disponible: false,
        mensaje: \`Ese horario ya está reservado para \${servicio}. Podés elegir otro horario u otra especialidad.\`
      };
    }`,
`    if (reservaExistente) {
      return {
        disponible: false,
        mensaje: \`Ese horario ya está reservado. Podés elegir otro horario.\`
      };
    }`
);

// 11. Update guardarReserva
content = content.replace(
`    const id = generateId();
    const reserva: Reservation = { ...datos, id };
    const key = reservaKey(datos.servicio, datos.fecha, datos.hora);
    const idKey = \`reserva:id:\${id}\`;

    if (kv) {
      const existente = await obtenerReservaEnSlot(datos.servicio, datos.fecha, datos.hora);`,
`    const id = generateId();
    const reserva: Reservation = { ...datos, id };
    const key = reservaKey(datos.profesional, datos.fecha, datos.hora);
    const idKey = \`reserva:id:\${id}\`;

    if (kv) {
      const existente = await obtenerReservaEnSlot(datos.profesional, datos.fecha, datos.hora);`
);
content = content.replace(
`    } else {
      const existente = await obtenerReservaEnSlot(datos.servicio, datos.fecha, datos.hora);`,
`    } else {
      const existente = await obtenerReservaEnSlot(datos.profesional, datos.fecha, datos.hora);`
);
content = content.replace(
`      await kv.del(reservaKey(reserva.servicio, reserva.fecha, reserva.hora));`,
`      await kv.del(reservaKey(reserva.profesional, reserva.fecha, reserva.hora));`
);

// 12. Main Menu and State Machine
content = content.replace(
`        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?', [
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);`,
`        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?\\n*(Atención particular, sin obra social)*', [
          [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);`
);
content = content.replace(
`      } else if (data === 'servicios') {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*',
          servicios.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }])
        );`,
`      } else if (data === 'profesionales') {
        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales:*',
          PROFESIONALES.map(p => [{ text: p, callback_data: \`profesional:\${p}\` }])
        );
      } else if (data === 'servicios') {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*',
          SERVICIOS.map(s => [{ text: \`\${s.nombre} - $\${s.precio}\`, callback_data: 'noop' }])
        );`
);
content = content.replace(
`        } else {
          await saveState({ paso: 'servicio' });
          await sendWithKeyboard(
            '¿Qué servicio querés reservar?',
            servicios.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }])
          );
        }`,
`        } else {
          await saveState({ paso: 'profesional' });
          await sendWithKeyboard(
            '¿Con qué profesional te querés atender?',
            PROFESIONALES.map(p => [{ text: p, callback_data: \`profesional:\${p}\` }])
          );
        }`
);
content = content.replace(
`            { text: \`\${r.servicio} — \${formatDate(r.fecha)} \${r.hora}\`, callback_data: 'noop' },`,
`            { text: \`\${r.servicio} con \${r.profesional} — \${formatDate(r.fecha)} \${r.hora}\`, callback_data: 'noop' },`
);

content = content.replace(
`      } else if (data.startsWith('servicio:')) {
        const servicioSeleccionado = data.replace('servicio:', '');
        if (estado.nombre && estado.fecha) {
          // Ya tiene nombre y fecha → ir directo a horarios
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
          const view = await buildHorariosView(estado.fecha, servicioSeleccionado);
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          await saveState({ paso: 'nombre', servicio: servicioSeleccionado });
          await sendWithKeyboard(\`*\${servicioSeleccionado}* ✔️\\n\\n¿Cuál es tu nombre?\`);
        }`,
`      } else if (data.startsWith('profesional:')) {
        const profSeleccionado = data.replace('profesional:', '');
        await saveState({ paso: 'servicio', profesional: profSeleccionado });
        await sendWithKeyboard(
          \`*\${profSeleccionado}* ✔️\\n\\n¿Qué servicio querés reservar?\`,
          SERVICIOS.map(s => [{ text: s.nombre, callback_data: \`servicio:\${s.nombre}\` }])
        );
      } else if (data.startsWith('servicio:')) {
        const servicioSeleccionado = data.replace('servicio:', '');
        if (estado.nombre && estado.fecha && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
          const view = await buildHorariosView(estado.fecha, servicioSeleccionado, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
          await sendWithKeyboard(\`*\${servicioSeleccionado}* ✔️\\n\\n¿Cuál es tu nombre?\`);
        }`
);

content = content.replace(
`      } else if (data === 'cambiar_fecha') {
        await saveState({ paso: 'fecha', servicio: estado.servicio, nombre: estado.nombre });
        const view = buildFechasView(estado.servicio);
        await sendWithKeyboard(view.text, view.keyboard);`,
`      } else if (data === 'cambiar_fecha') {
        await saveState({ paso: 'fecha', servicio: estado.servicio, nombre: estado.nombre, profesional: estado.profesional });
        const view = buildFechasView(estado.servicio, estado.profesional);
        await sendWithKeyboard(view.text, view.keyboard);`
);
content = content.replace(
`      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (estado.servicio) {
          await saveState({ ...estado, paso: 'hora', fecha: fechaSeleccionada });
          const view = await buildHorariosView(fechaSeleccionada, estado.servicio);
          await sendWithKeyboard(view.text, view.keyboard);
        }`,
`      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (estado.servicio && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', fecha: fechaSeleccionada });
          const view = await buildHorariosView(fechaSeleccionada, estado.servicio, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        }`
);

content = content.replace(
`      } else if (data === 'refresh_horarios') {
        if (estado.fecha && estado.servicio) {
          const view = await buildHorariosView(estado.fecha, estado.servicio);
          await sendWithKeyboard(view.text, view.keyboard);
        }`,
`      } else if (data === 'refresh_horarios') {
        if (estado.fecha && estado.servicio && estado.profesional) {
          const view = await buildHorariosView(estado.fecha, estado.servicio, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        }`
);

content = content.replace(
`        // Verificar disponibilidad antes de mostrar confirmación
        const disponibilidad = await verificarDisponibilidad(estado.servicio!, estado.fecha!, horaSeleccionada);`,
`        // Verificar disponibilidad antes de mostrar confirmación
        const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, horaSeleccionada);`
);

content = content.replace(
`          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!);`,
`          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);`
);

content = content.replace(
`        const disponibilidad = await verificarDisponibilidad(estado.servicio!, estado.fecha!, estado.hora!);`,
`        const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, estado.hora!);`
);

content = content.replace(
`          const datosReserva = {
            servicio: estado.servicio!,
            nombre: estado.nombre!,
            fecha: estado.fecha!,
            hora: estado.hora!,
            chatId: chatId
          };`,
`          const datosReserva = {
            profesional: estado.profesional!,
            servicio: estado.servicio!,
            nombre: estado.nombre!,
            fecha: estado.fecha!,
            hora: estado.hora!,
            chatId: chatId
          };`
);

content = content.replace(
`              \`🎉 *¡Reserva confirmada!*\\n\\n\` +
              \`✨ *\${reserva.servicio}*\\n\` +
              \`📅 \${formatDate(reserva.fecha)}\\n\` +
              \`🕐 \${reserva.hora}\\n\` +
              \`👤 \${reserva.nombre}\\n\\n\` +
              \`¡Nos vemos! 😊\`,`,
`              \`🎉 *¡Reserva confirmada!*\\n\\n\` +
              \`👨‍⚕️ \${reserva.profesional}\\n\` +
              \`✨ *\${reserva.servicio}*\\n\` +
              \`📅 \${formatDate(reserva.fecha)}\\n\` +
              \`🕐 \${reserva.hora}\\n\` +
              \`👤 \${reserva.nombre}\\n\\n\` +
              \`¡Nos vemos! 😊\`,`
);

content = content.replace(
`            const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!);`,
`            const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);`
);

content = content.replace(
`          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!);`,
`          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);`
);

// Fallback handlers replacing
content = content.replace(
`      const showMainMenu = async () => {
        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?', [
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);
      };

      const showServices = async () => {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*',
          servicios.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }])
        );
      };

      const showHorarios = async (fechaStr: string, servicio: string) => {
        await saveState({ paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr });
        const view = await buildHorariosView(fechaStr, servicio);
        await sendWithKeyboard(view.text, view.keyboard);
      };`,
`      const showMainMenu = async () => {
        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?\\n*(Atención particular, sin obra social)*', [
          [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);
      };

      const showServices = async () => {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*',
          SERVICIOS.map(s => [{ text: \`\${s.nombre} - $\${s.precio}\`, callback_data: 'noop' }])
        );
      };

      const showHorarios = async (fechaStr: string, servicio: string, profesional: string) => {
        await saveState({ ...estado, paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr, profesional });
        const view = await buildHorariosView(fechaStr, servicio, profesional);
        await sendWithKeyboard(view.text, view.keyboard);
      };`
);

content = content.replace(
`        } else {
          await saveState({ paso: 'servicio' });
          await sendWithKeyboard(
            '¿Qué servicio querés reservar?',
            servicios.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }])
          );
        }`,
`        } else {
          await saveState({ paso: 'profesional' });
          await sendWithKeyboard(
            '¿Con qué profesional te querés atender?',
            PROFESIONALES.map(p => [{ text: p, callback_data: \`profesional:\${p}\` }])
          );
        }`
);

content = content.replace(
`        if (estado.paso === 'servicio') {
          let servicioSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= servicios.length) {
            servicioSeleccionado = servicios[num - 1];
          } else {
            servicioSeleccionado = servicios.find(s =>
              s.toLowerCase().includes(text.toLowerCase())
            );
          }

          if (servicioSeleccionado) {
            await saveState({ paso: 'nombre', servicio: servicioSeleccionado });
            await sendWithKeyboard(\`*\${servicioSeleccionado}* ✔️\\n\\n¿Cuál es tu nombre?\`);
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              servicios.map(s => [{ text: s, callback_data: \`servicio:\${s}\` }])
            );
          }

        } else if (estado.paso === 'nombre') {
          await saveState({ paso: 'fecha', servicio: estado.servicio, nombre: text });
          const view = buildFechasView(estado.servicio);
          await sendWithKeyboard(\`Hola *\${text}* 👋\\n\\n\${view.text}\`, view.keyboard);`,
`        if (estado.paso === 'profesional') {
          let profSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= PROFESIONALES.length) {
            profSeleccionado = PROFESIONALES[num - 1];
          } else {
            profSeleccionado = PROFESIONALES.find(p => p.toLowerCase().includes(text.toLowerCase()));
          }
          if (profSeleccionado) {
            await saveState({ paso: 'servicio', profesional: profSeleccionado });
            await sendWithKeyboard(
              \`*\${profSeleccionado}* ✔️\\n\\n¿Qué servicio querés reservar?\`,
              SERVICIOS.map(s => [{ text: s.nombre, callback_data: \`servicio:\${s.nombre}\` }])
            );
          } else {
            await sendWithKeyboard('Elegí un profesional válido:', PROFESIONALES.map(p => [{ text: p, callback_data: \`profesional:\${p}\` }]));
          }
        } else if (estado.paso === 'servicio') {
          let servicioSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= SERVICIOS.length) {
            servicioSeleccionado = SERVICIOS[num - 1].nombre;
          } else {
            servicioSeleccionado = SERVICIOS.find(s => s.nombre.toLowerCase().includes(text.toLowerCase()))?.nombre;
          }

          if (servicioSeleccionado) {
            await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
            await sendWithKeyboard(\`*\${servicioSeleccionado}* ✔️\\n\\n¿Cuál es tu nombre?\`);
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              SERVICIOS.map(s => [{ text: s.nombre, callback_data: \`servicio:\${s.nombre}\` }])
            );
          }

        } else if (estado.paso === 'nombre') {
          await saveState({ ...estado, paso: 'fecha', nombre: text });
          const view = buildFechasView(estado.servicio, estado.profesional);
          await sendWithKeyboard(\`Hola *\${text}* 👋\\n\\n\${view.text}\`, view.keyboard);`
);

content = content.replace(
`          if (fechaParseada && esDiaLaborable(fechaParseada)) {
            await showHorarios(fechaParseada, estado.servicio!);
          } else if (fechaParseada && !esDiaLaborable(fechaParseada)) {
            await sendWithKeyboard(
              '❌ No atendemos fines de semana. Elegí un día de lunes a viernes:',
              buildFechasKeyboard()
            );
          } else {
            const view = buildFechasView(estado.servicio);
            await sendWithKeyboard('Elegí un día de la lista:', view.keyboard);
          }`,
`          if (fechaParseada && esDiaLaborable(fechaParseada, estado.profesional)) {
            await showHorarios(fechaParseada, estado.servicio!, estado.profesional!);
          } else if (fechaParseada && !esDiaLaborable(fechaParseada, estado.profesional)) {
            await sendWithKeyboard(
              '❌ El profesional no atiende ese día. Elegí otro:',
              buildFechasKeyboard(estado.profesional)
            );
          } else {
            const view = buildFechasView(estado.servicio, estado.profesional);
            await sendWithKeyboard('Elegí un día de la lista:', view.keyboard);
          }`
);

content = content.replace(
`        } else if (estado.paso === 'hora') {
          const horariosLibres = await obtenerHorariosLibres(estado.fecha!, estado.servicio!);`,
`        } else if (estado.paso === 'hora') {
          const horariosLibres = await obtenerHorariosLibres(estado.fecha!, estado.profesional!, estado.servicio!);`
);

content = content.replace(
`            const disponibilidad = await verificarDisponibilidad(estado.servicio!, estado.fecha!, horaSeleccionada);`,
`            const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, horaSeleccionada);`
);

content = content.replace(
`              const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!);`,
`              const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);`
);

content = content.replace(
`          } else {
            await showHorarios(estado.fecha!, estado.servicio!);
          }`,
`          } else {
            await showHorarios(estado.fecha!, estado.servicio!, estado.profesional!);
          }`
);

fs.writeFileSync(routePath, content);
console.log("Reemplazos realizados con exito.");
