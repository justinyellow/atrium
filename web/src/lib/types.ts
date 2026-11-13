export type Level = 'none' | 'view' | 'comment' | 'edit' | 'full';
export type Role = 'owner' | 'admin' | 'member' | 'guest';

export interface Me {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  theme: 'system' | 'light' | 'dark';
  role: Role;
  workspaceId: string;
  workspace: { id: string; name: string; icon: string | null };
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: Role;
  active: boolean;
}

export interface TreePage {
  id: string;
  parent_id: string | null;
  teamspace_id: string | null;
  kind: 'page' | 'database' | 'row';
  title: string;
  icon: string | null;
  position: number;
  level: Level;
  private: boolean;
}

export interface Teamspace {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  is_default: boolean;
  default_level: Level;
  my_role: 'owner' | 'member' | null;
  member_count: number;
}

export interface Tree {
  pages: TreePage[];
  teamspaces: Teamspace[];
  favorites: { id: string; title: string; icon: string | null; kind: string }[];
  shared: string[];
}

export interface Page {
  id: string;
  parent_id: string | null;
  teamspace_id: string | null;
  owner_id: string | null;
  kind: 'page' | 'database' | 'row';
  title: string;
  icon: string | null;
  cover: string | null;
  cover_position: number;
  props: Record<string, any>;
  full_width: boolean;
  small_text: boolean;
  locked: boolean;
  is_template: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  level: Level;
  favorite: boolean;
  breadcrumbs: { id: string; title: string; icon: string | null; kind: string }[];
  created_by_user: { id: string; name: string; avatar_url: string | null } | null;
  updated_by_user: { id: string; name: string; avatar_url: string | null } | null;
  teamspace: { id: string; name: string; icon: string | null } | null;
  parent_schema: Prop[] | null;
  public_slug: string | null;
}

export type PropType =
  | 'title' | 'text' | 'number' | 'select' | 'multi_select' | 'status' | 'date' | 'person' | 'checkbox'
  | 'url' | 'email' | 'phone' | 'files' | 'relation' | 'rollup' | 'formula'
  | 'created_time' | 'created_by' | 'last_edited_time' | 'last_edited_by' | 'unique_id' | 'ai'
  | 'place' | 'verification' | 'button';

export interface SelectOption { id: string; name: string; color: string; group?: 'todo' | 'in_progress' | 'complete' }

export interface Prop {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  number_format?: string;
  relation?: { databaseId: string; syncedPropId?: string | null };
  rollup?: { relationPropId: string; targetPropId: string; fn: string };
  formula?: { expression: string };
  /** AI autofill config (type 'ai'). */
  ai?: { instruction: string; kind: 'summary' | 'keywords' | 'translate' | 'custom'; language?: string; outputType: 'text' | 'select' | 'multi_select'; autoUpdate: boolean };
  date_format?: string;
  id_prefix?: string;
  /** Shown as a tooltip on the column header and in the property menu. */
  description?: string;
  /** person: 'one' limits the property to a single person. */
  limit?: 'one' | 'many';
  /** button: label + actions run per row. */
  button?: { label: string; actions: ButtonPropAction[] };
}

export type ButtonPropAction =
  | { type: 'setProps'; props: Record<string, any> }
  | { type: 'addRow'; databaseId: string; title?: string; props: Record<string, any> }
  | { type: 'insert'; markdown?: string; blocks: any[] }
  | { type: 'open'; target: string };

export interface PlaceValue { lat: number; lng: number; name?: string; address?: string }
export interface VerificationValue { state: 'verified' | 'unverified' | 'expired'; by?: string; at?: string; until?: string }

export interface ChartConfig {
  kind: 'bar' | 'column' | 'line' | 'area' | 'donut' | 'number';
  xProp?: string;
  groupProp?: string;
  aggregate: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median'; prop?: string };
  sort?: 'x-asc' | 'x-desc' | 'value-asc' | 'value-desc';
  cumulative?: boolean;
  hideEmpty?: boolean;
  showLegend?: boolean;
  bucket?: 'day' | 'week' | 'month' | 'year';
}
export interface FormQuestion { propId: string; label?: string; description?: string; required?: boolean }
export interface FormConfig { title?: string; description?: string; questions: FormQuestion[]; submitLabel?: string; access: 'members' | 'link'; thankYou?: string; slug?: string }
export interface DashboardWidget { id: string; title?: string; kind: 'chart' | 'number' | 'table' | 'list' | 'board'; viewConfig: Partial<ViewConfig> & { limit?: number }; x: number; y: number; w: number; h: number }

export interface Filter { prop: string; op: string; value?: any }
export interface FilterGroup { op: 'and' | 'or'; filters: Filter[] }

export interface ViewConfig {
  filter?: FilterGroup;
  sorts?: { prop: string; dir: 'asc' | 'desc' }[];
  groupBy?: string | null;
  hiddenGroups?: string[];
  properties?: { id: string; visible: boolean; width?: number }[];
  calendarBy?: string;
  timelineBy?: string;
  cardPreview?: 'none' | 'cover' | 'content';
  cardSize?: 'small' | 'medium' | 'large';
  calculations?: Record<string, string>;
  wrap?: boolean;
  openIn?: 'side' | 'center' | 'full';
  chart?: ChartConfig;
  form?: FormConfig;
  dashboard?: { widgets: DashboardWidget[] };
  map?: { placeProp: string };
  /** Pinned filters shown as toggle chips above the view (Notion quick filters). */
  quickFilters?: Filter[];
}

export interface DbView {
  id: string;
  database_id: string;
  name: string;
  type: 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart' | 'form' | 'dashboard' | 'map';
  config: ViewConfig;
  position: number;
}

export interface Database extends Omit<Page, 'breadcrumbs' | 'favorite' | 'created_by_user' | 'updated_by_user' | 'teamspace' | 'parent_schema'> {
  schema: Prop[];
  views: DbView[];
  templates: { id: string; title: string; icon: string | null }[];
  /** Shown under the database title. */
  description?: string | null;
  /** Template the "New" button uses. */
  default_template_id?: string | null;
}

export interface Row {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  props: Record<string, any>;
  position: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  computed: Record<string, any>;
  subpages?: number;
}

export interface QueryResult {
  schema: Prop[];
  rows: Row[];
  titles: Record<string, string>;
}
