/**
 * Comandos del portal en el bot. Importar este módulo registra los manejadores de B1; los comandos reconocidos por el
 * router sin manejador todavía (avance, prepropuesta) responden "pronto" hasta que su bloque los
 * registre con registerPortalCommand.
 */
import "./portal";
import "./ayuda";
import "./hoy";
import "./empresa";
import "./asignarme";
import "./contacto";
import "./cita";
import "./cotizacion";
import "./oc";
import "./prepropuesta";
import "./avance";
import "./estado";
import "./mejores";
import "./ventas";
import "./nueva-empresa";

export const COMMAND_LABEL: Record<string, string> = {
  cita: "cita",
  oc: "oc",
  avance: "avance",
  prepropuesta: "prepropuesta",
  aprende: "aprende",
};

export const comingSoon = (name: string): string => `*${COMMAND_LABEL[name] ?? name}* estará disponible pronto. Escribe *ayuda portal* para ver lo que ya funciona.`;
