/**
 * Icon — thin wrapper around lucide-react with prototype's icon name compatibility.
 *
 * Use the same names as the prototype (e.g., "arrow_right", "check_circle")
 * for easy porting. They map to lucide icons internally.
 *
 * @example
 * <Icon name="arrow_right" size={16} />
 * <Icon name="rupee" className="text-emerald" />
 */
import {
  ArrowRight, ArrowLeft, ArrowUp, ArrowDown, ArrowUpRight,
  Home, Inbox, Target, Users, User, FileText, Receipt, RefreshCw,
  Clock, Package, Zap, Bell, Search, Plus, Check, CheckCircle2,
  X, XCircle, AlertTriangle, Info, Mail, Phone, MessageSquare,
  Settings, BarChart3, PieChart, Layout, Shield, Globe, Download,
  Upload, Filter, MoreHorizontal, MoreVertical, Edit, Trash2, Copy,
  Link, ExternalLink, Calendar, Star, Bolt, GripVertical, ChevronDown,
  ChevronUp, ChevronLeft, ChevronRight, Play, Lock, LogOut, Sparkles,
  IndianRupee, ShoppingCart, Award, Database, Layers, PaintBucket,
  Rocket, HelpCircle, Ticket, BookOpen, Smile, TrendingUp, TrendingDown,
  Smartphone, Sun, Moon, Building2, Briefcase, SlidersHorizontal,
  List, Grid3x3, Send, ArrowUpDown, Bookmark,
  Eye, Bug, Wallet, Printer, Laptop, Camera, Menu, Circle, Image as ImageIcon,
  Mic, MicOff, Square, MapPin, MessagesSquare,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

// Map prototype icon names → lucide components
const ICON_MAP: Record<string, LucideIcon> = {
  // Navigation
  home: Home,
  arrow_right: ArrowRight,
  arrow_left: ArrowLeft,
  arrow_up: ArrowUp,
  arrow_down: ArrowDown,
  arrow_up_right: ArrowUpRight,
  chevron_down: ChevronDown,
  chevron_up: ChevronUp,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,

  // Entities
  inbox: Inbox,
  target: Target,
  users: Users,
  user: User,
  file: FileText,
  receipt: Receipt,
  package: Package,
  building: Building2,
  briefcase: Briefcase,

  // Status / actions
  refresh: RefreshCw,
  clock: Clock,
  zap: Zap,
  bell: Bell,
  search: Search,
  plus: Plus,
  check: Check,
  check_circle: CheckCircle2,
  x: X,
  x_circle: XCircle,
  alert: AlertTriangle,
  info: Info,
  edit: Edit,
  pencil: Edit,
  trash: Trash2,
  copy: Copy,
  link: Link,
  external: ExternalLink,
  filter: Filter,
  more_h: MoreHorizontal,
  more_v: MoreVertical,
  download: Download,
  upload: Upload,
  send: Send,

  // Communication
  mail: Mail,
  phone: Phone,
  message: MessageSquare,
  /* R-2300: Team chat (two bubbles) — never the single bubble of AI Help ("message"). */
  chat: MessagesSquare,
  // whatsapp → real brand mark, rendered by Icon() below (not a lucide glyph)

  // System
  settings: Settings,
  shield: Shield,
  map_pin: MapPin,
  globe: Globe,
  lock: Lock,
  logout: LogOut,
  database: Database,
  layout: Layout,
  layers: Layers,
  paint: PaintBucket,
  sliders: SlidersHorizontal,
  list: List,
  sort: ArrowUpDown,
  bookmark: Bookmark,
  grid: Grid3x3,
  grip: GripVertical,

  // Charts
  chart: BarChart3,
  pie: PieChart,
  trending_up: TrendingUp,
  trending_down: TrendingDown,

  // Calendar / time
  calendar: Calendar,
  play: Play,

  // Misc
  star: Star,
  bolt: Bolt,
  sparkles: Sparkles,
  smile: Smile,
  question: HelpCircle,
  ticket: Ticket,
  book: BookOpen,
  rocket: Rocket,
  award: Award,
  cart: ShoppingCart,
  rupee: IndianRupee,
  sun: Sun,
  moon: Moon,
  mobile: Smartphone,
  /* Bolkar likhne ke liye — pehle iski jagah `mobile` (Smartphone) use hua tha, jo
     dictation button par phone jaisa dikhta tha aur "call" padha jata tha. */
  mic: Mic,
  mic_off: MicOff,
  /* Column-hide menu me "chhupa hua" dikhane ke liye — khaali dabba. */
  square: Square,

  // ── Added 2026-08-13 ────────────────────────────────────────────────────────
  // Every one of these was being called somewhere in the app but was absent from
  // the map, so it fell through to the AlertTriangle fallback and rendered a
  // WARNING SIGN in normal UI — the breadcrumb separator, the mobile hamburger,
  // the Report Bug button, view/preview buttons, the sidebar's My Expenses item.
  eye: Eye,
  bug: Bug,
  wallet: Wallet,
  printer: Printer,
  laptop: Laptop,
  camera: Camera,
  menu: Menu,
  image: ImageIcon,

  // Aliases. The map's own vocabulary is short (`chart`, `more_h`, `mobile`,
  // `message`, `question`) but call sites reach for the lucide/HTML-ish names.
  // Accepting both is cheaper than policing 70+ call sites, and a wrong icon
  // name should never be a user-visible warning.
  bar_chart: BarChart3,
  more_horizontal: MoreHorizontal,
  smartphone: Smartphone,
  message_square: MessageSquare,
  help_circle: HelpCircle,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
};

export interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: keyof typeof ICON_MAP | string;
  size?: number;
}

/**
 * The real WhatsApp brand mark — solid green speech bubble with the white
 * phone handset (the recognisable app-icon look). Self-coloured, so it stays
 * on-brand regardless of the surrounding text colour. Lucide has no WhatsApp
 * glyph, so we render the authentic logo here.
 */
function WhatsAppMark({ size = 16, className, ...rest }: Omit<IconProps, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      <path
        fill="#25D366"
        d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"
      />
      <path
        fill="#FFF"
        d="M17.498 14.382c-.301-.15-1.767-.867-2.04-.966-.273-.101-.473-.15-.673.15-.197.295-.771.964-.944 1.162-.175.195-.349.21-.646.075-.3-.15-1.263-.465-2.403-1.485-.888-.795-1.484-1.77-1.66-2.07-.174-.3-.019-.465.13-.615.136-.135.301-.345.451-.523.146-.181.194-.301.297-.496.1-.21.049-.375-.025-.524-.075-.15-.672-1.62-.922-2.206-.24-.584-.487-.51-.672-.51-.172-.015-.371-.015-.571-.015-.2 0-.523.074-.797.359-.273.3-1.045 1.02-1.045 2.475s1.07 2.865 1.219 3.075c.149.195 2.105 3.195 5.1 4.485.714.3 1.27.48 1.704.629.714.227 1.365.195 1.88.121.574-.091 1.767-.721 2.016-1.426.255-.705.255-1.29.18-1.425-.074-.135-.27-.21-.57-.345z"
      />
    </svg>
  );
}

/**
 * Render an icon by prototype-compatible name.
 *
 * Unknown name → renders the AlertTriangle icon as a visible "missing icon" indicator
 * (instead of silent fail) so we catch typos early in dev.
 */
/**
 * A phone handset for the Call action — flat (no disc) and in amber, so it
 * reads clearly apart from the green WhatsApp logo sitting right beside it.
 */
function CallMark({ size = 16, className, ...rest }: Omit<IconProps, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      <path
        fill="#EA580C"
        d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
      />
    </svg>
  );
}

/**
 * A flat, single-colour glyph (no disc) — the plain "logo / PNG" look. Used
 * for the quote and follow-up actions.
 */
function GlyphMark({ size = 16, className, fill, d, ...rest }: Omit<IconProps, "name"> & { fill: string; d: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      <path fill={fill} d={d} />
    </svg>
  );
}

/**
 * The real Gmail logo — the four-colour "M" envelope. Used for the Email
 * action (which opens Gmail), so it's instantly recognisable.
 */
function GmailMark({ size = 16, className, ...rest }: Omit<IconProps, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={cn("inline-block flex-shrink-0", className)}
      aria-hidden="true"
      {...rest}
    >
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8 4.924 8 3 9.924 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8 43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
}

// Flat Material glyph paths (24-grid) for the coloured action glyphs.
const GLYPH_DOC = "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z";
const GLYPH_CLOCK = "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z";

export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  if (name === "whatsapp") return <WhatsAppMark size={size} className={className} {...rest} />;
  if (name === "call") return <CallMark size={size} className={className} {...rest} />;
  if (name === "quote") return <GlyphMark size={size} className={className} fill="#2563EB" d={GLYPH_DOC} {...rest} />;
  if (name === "reminder") return <GlyphMark size={size} className={className} fill="#7C3AED" d={GLYPH_CLOCK} {...rest} />;
  if (name === "email") return <GmailMark size={size} className={className} {...rest} />;
  // Fallback for an unknown name. It used to be AlertTriangle in every
  // environment, which meant a simple typo rendered a WARNING SIGN to the user —
  // "Sales ⚠ Customers" in the breadcrumb, ⚠ on the hamburger, ⚠ on Report Bug.
  // A missing icon is a developer problem, never a user alert. So: stay loud in
  // development (triangle + the rose tint below), and degrade to a neutral dot in
  // production, where it reads as nothing rather than as danger.
  const isKnown = Boolean(ICON_MAP[name]);
  const Component =
    ICON_MAP[name] ?? (process.env.NODE_ENV === "development" ? AlertTriangle : Circle);
  return (
    <Component
      width={size}
      height={size}
      className={cn(
        "inline-block flex-shrink-0",
        !isKnown && process.env.NODE_ENV === "development" && "text-rose",
        className
      )}
      strokeWidth={1.6}
      aria-hidden="true"
      {...rest}
    />
  );
}

// Backward-compat alias for prototype's `<I />` component
export { Icon as I };
