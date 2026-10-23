import {
  ArrowLeft,
  ArrowUp,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Grid3x3,
  Heart,
  House,
  ImageOff,
  Images,
  Lock,
  LogOut,
  Menu,
  MessageCircle,
  Moon,
  Search,
  Send,
  Settings,
  Smile,
  SquarePen,
  SquarePlus,
  Sun,
  UserPlus,
  X,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  FeedPostWithLikes,
  DiscoveredProfile,
  PostComment,
  PostCommentsResponse,
  PostFeedResponse,
  PostLikeState,
  PostResponse,
  Notification,
  NotificationsResponse,
  ConversationSummary,
  ConversationsResponse,
  DirectMessage,
  DirectMessagesResponse,
  FollowState,
  ProfileSummary,
  UserDiscoveryResponse,
} from '@lumen/shared';
import { resolveApiBaseUrl } from './api-base-url.js';
import './app.css';

type User = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  isPrivate?: boolean;
};

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

type ApiErrorBody = {
  error?: {
    code?: string;
  };
};

const api = resolveApiBaseUrl(import.meta.env.PROD, import.meta.env.VITE_API_URL);
const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const safeMessages: Record<string, string> = {
  ACCOUNT_EXISTS: 'An account with those details already exists.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  VALIDATION_ERROR: 'Check your information and try again.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  CSRF_REJECTED: 'Your request could not be verified. Please try again.',
  UNAVAILABLE: 'The service is temporarily unavailable. Please try again later.',
  INTERNAL_ERROR: 'The service is temporarily unavailable. Please try again later.',
  INVALID_UPLOAD: 'Choose a valid JPEG, PNG, or WebP image.',
  UPLOAD_TOO_LARGE: 'Images must be 8 MB or smaller.',
  PRIVATE_PROFILE: 'This post is private.',
  NOT_FOUND: 'Profile not found.',
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(safeMessages[code ?? ''] ?? 'The request could not be completed. Please try again.');
  }
}

class NetworkError extends Error {
  constructor() {
    super('Unable to reach the service. Check your connection and try again.');
  }
}

function userErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError || error instanceof NetworkError) {
    return error.message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function getErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }

  const error = (body as ApiErrorBody).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

let sessionExpiredHandler: (() => void) | undefined;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof window.FormData)) {
    headers.set('content-type', 'application/json');
  }

  try {
    if (mutationMethods.has(method)) {
      const csrfResponse = await fetch(`${api}/csrf`, { credentials: 'include' });
      const csrfBody = await readJson(csrfResponse);
      if (!csrfResponse.ok) {
        throw new ApiError(csrfResponse.status, getErrorCode(csrfBody));
      }

      const token =
        typeof csrfBody === 'object' && csrfBody !== null && 'data' in csrfBody
          ? (csrfBody.data as { csrfToken?: unknown }).csrfToken
          : undefined;
      if (typeof token !== 'string') {
        throw new Error('Invalid CSRF response');
      }
      headers.set('x-csrf-token', token);
    }

    const response = await fetch(`${api}${path}`, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });
    const body = response.status === 204 ? undefined : await readJson(response);
    if (!response.ok) {
      // An expired or revoked session anywhere in the app sends the user back to log in.
      if (response.status === 401 && !path.startsWith('/auth/')) sessionExpiredHandler?.();
      throw new ApiError(response.status, getErrorCode(body));
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new NetworkError();
  }
}

type AuthResponse = { data: { user: User } };
type RestoreState = 'loading' | 'ready' | 'error';

/* ------------------------------------------------------------------ */
/* Routing, theme, toasts                                              */
/* ------------------------------------------------------------------ */

type Route =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'edit' }
  | { name: 'profile'; username: string };

function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/direct/inbox') return { name: 'inbox' };
  if (path === '/accounts/edit') return { name: 'edit' };
  const match = /^\/([a-zA-Z0-9._]{3,30})$/.exec(path);
  return match ? { name: 'profile', username: match[1].toLowerCase() } : { name: 'home' };
}

function routePath(route: Route) {
  switch (route.name) {
    case 'home':
      return '/';
    case 'inbox':
      return '/direct/inbox';
    case 'edit':
      return '/accounts/edit';
    case 'profile':
      return `/${route.username}`;
  }
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = routePath(next);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(next);
    document.documentElement.scrollTo?.({ top: 0 });
  }, []);

  return { route, navigate };
}

type Theme = 'light' | 'dark';
const themeStorageKey = 'rubaagram-theme';

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme | null>(readStoredTheme);
  const prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective: Theme = theme ?? (prefersDark ? 'dark' : 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = effective;
  }, [effective]);

  const toggle = useCallback(() => {
    const next: Theme = effective === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      window.localStorage.setItem(themeStorageKey, next);
    } catch {
      // Theme still applies for this visit.
    }
  }, [effective]);

  return { theme: effective, toggle };
}

type ToastTone = 'info' | 'error';
type Toast = { id: number; message: string; tone: ToastTone };
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region">
        {toasts.map((toast) => (
          <p
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            {toast.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function useToast() {
  return useContext(ToastContext);
}

function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onEscape, active]);
}

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

/**
 * Re-runs `callback` every `intervalMs` while the tab is visible, and right away when the
 * tab becomes visible again, so counts and conversations stay current without a reload.
 */
function usePolling(callback: () => void, intervalMs: number, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState !== 'hidden') saved.current();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [intervalMs, enabled]);
}

/** Calls `onVisible` when the sentinel scrolls into view (infinite scroll). */
function useInfiniteScroll(onVisible: () => void, enabled: boolean) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onVisible);
  callback.current = onVisible;

  useEffect(() => {
    const node = sentinel.current;
    if (!enabled || !node || typeof window.IntersectionObserver !== 'function') return;
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return sentinel;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function timeAgo(iso: string, now = Date.now()) {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fullDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

function formatCount(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? 'compact' : 'standard' })
    .format(value)
    .toLowerCase();
}

function plural(count: number, one: string, many: string) {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/* ------------------------------------------------------------------ */
/* Shared UI                                                           */
/* ------------------------------------------------------------------ */

function Wordmark({ className = '' }: { className?: string }) {
  return <span className={`wordmark ${className}`}>Rubaagram</span>;
}

/** Uploaded media is served by the API under a relative path; external URLs pass through. */
function mediaUrl(src: string) {
  return src.startsWith('/') ? `${api}${src}` : src;
}

function Avatar({
  username,
  src,
  size = 32,
}: {
  username: string;
  src?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
      title={username}
    >
      {src && !failed ? (
        <img src={mediaUrl(src)} alt="" onError={() => setFailed(true)} />
      ) : (
        <svg viewBox="0 0 40 40" className="avatar-fallback">
          <circle cx="20" cy="15.5" r="7" />
          <path d="M6.5 35c1.6-7 7-10.5 13.5-10.5S31.9 28 33.5 35a19.6 19.6 0 0 1-27 0Z" />
        </svg>
      )}
    </span>
  );
}

/**
 * A post photo served by the API. If the file is gone (for example lost from a host's
 * temporary disk) it shows a placeholder instead of the browser's broken-image icon.
 */
function PostImage({
  src,
  alt,
  className,
  loading,
  compact = false,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (failed) {
    return (
      <span
        className={`image-unavailable ${compact ? 'is-compact' : ''} ${className ?? ''}`}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        <ImageOff aria-hidden="true" />
        {!compact && <span>Photo unavailable</span>}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={`${api}${src}`}
      alt={alt}
      crossOrigin="use-credentials"
      loading={loading}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function Spinner({ label, size = 18 }: { label?: string; size?: number }) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

function Modal({
  labelledBy,
  onClose,
  className = '',
  children,
  closeLabel = 'Close',
  showClose = true,
}: {
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  closeLabel?: string;
  showClose?: boolean;
}) {
  useEscape(onClose);
  useBodyScrollLock(true);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {showClose && (
        <button type="button" className="modal-close" aria-label={closeLabel} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      )}
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  avatar,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  avatar?: ReactNode;
}) {
  return (
    <Modal labelledBy="confirm-title" onClose={onCancel} className="confirm-dialog" showClose={false}>
      <div className="confirm-body">
        {avatar}
        <h2 id="confirm-title">{title}</h2>
        {body && <p>{body}</p>}
      </div>
      <button type="button" className="confirm-action is-danger" onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button type="button" className="confirm-action" onClick={onCancel}>
        Cancel
      </button>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

const loginPath = '/accounts/login';
const signupPath = '/accounts/signup';
const authPaths = new Set([loginPath, signupPath]);

function isAuthPath(pathname: string) {
  return authPaths.has(pathname.replace(/\/+$/, ''));
}

/** Where to go after signing in: the page that sent us to log in, if it is a safe in-app path. */
function postLoginPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  return isAuthPath(new URL(next, window.location.origin).pathname) ? '/' : next;
}

/**
 * Signed-out visitors to the home page get the full login page. Any other app page keeps
 * its address and shows a login popup on top (see LoginWall), so signing in lands there.
 */
function redirectToLogin() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') window.history.replaceState(null, '', loginPath);
}

function Root() {
  const [user, setUserState] = useState<User | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>('loading');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [, setLocationVersion] = useState(0);
  const theme = useTheme();

  // Keep the URL in step with the session: signed-in users never sit on the login page.
  const setUser = useCallback((next: User | null) => {
    if (next && isAuthPath(window.location.pathname)) {
      window.history.replaceState(null, '', postLoginPath());
    }
    if (!next) redirectToLogin();
    setUserState(next);
  }, []);

  // While signed out, back/forward moves between the login page and the login popup.
  useEffect(() => {
    if (user) return;
    const onPopState = () => setLocationVersion((version) => version + 1);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [user]);

  useEffect(() => {
    sessionExpiredHandler = () => setUser(null);
    return () => {
      sessionExpiredHandler = undefined;
    };
  }, [setUser]);

  useEffect(() => {
    let active = true;
    setRestoreState('loading');

    request<AuthResponse>('/auth/me')
      .then((response) => {
        if (active) {
          setUser(response.data.user);
          setRestoreState('ready');
        }
      })
      .catch((restoreError: unknown) => {
        if (!active) {
          return;
        }
        if (restoreError instanceof ApiError && restoreError.status === 401) {
          setUser(null);
          setRestoreState('ready');
          return;
        }
        setRestoreState('error');
      });

    return () => {
      active = false;
    };
  }, [restoreAttempt, setUser]);

  if (restoreState === 'loading') {
    return (
      <main className="splash">
        <span className="splash-logo" aria-hidden="true">
          <Camera />
        </span>
        <p role="status" className="sr-only">
          Restoring session…
        </p>
      </main>
    );
  }

  if (restoreState === 'error') {
    return (
      <main className="auth-page">
        <section className="auth-box" aria-labelledby="restore-error-title">
          <Wordmark className="auth-wordmark" />
          <h1 id="restore-error-title" className="auth-title">
            Unable to restore your session
          </h1>
          <p className="auth-subtitle" role="alert">
            The service could not be reached. Please try again.
          </p>
          <button
            className="btn btn-primary btn-block"
            onClick={() => setRestoreAttempt((attempt) => attempt + 1)}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  if (user) {
    return <Shell user={user} setUser={setUser} theme={theme.theme} toggleTheme={theme.toggle} />;
  }

  if (!isAuthPath(window.location.pathname)) {
    return (
      <LoginWall
        onAuthenticated={setUser}
        onSignUp={() => {
          const requested = `${window.location.pathname}${window.location.search}`;
          window.history.pushState(
            null,
            '',
            `${signupPath}?${new URLSearchParams({ next: requested })}`,
          );
          setLocationVersion((version) => version + 1);
        }}
      />
    );
  }

  return <AuthPage onAuthenticated={setUser} />;
}

function AuthField({
  label,
  name,
  type = 'text',
  minLength,
  maxLength,
  autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  minLength?: number;
  maxLength?: number;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [hasValue, setHasValue] = useState(false);
  const isPassword = type === 'password';
  return (
    <div className="auth-field">
      <label>
        <input
          name={name}
          type={isPassword && visible ? 'text' : type}
          minLength={minLength}
          maxLength={maxLength}
          autoComplete={autoComplete}
          placeholder=" "
          required
          onChange={(event) => setHasValue(event.currentTarget.value.length > 0)}
        />
        <span className="auth-field-label">{label}</span>
      </label>
      {isPassword && hasValue && (
        <button
          type="button"
          className="auth-field-toggle"
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      )}
    </div>
  );
}

function AuthPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [register, setRegisterState] = useState(
    () => window.location.pathname.replace(/\/+$/, '') === signupPath,
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onPopState = () =>
      setRegisterState(window.location.pathname.replace(/\/+$/, '') === signupPath);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function setRegister(next: boolean) {
    // Keep ?next= so signing up still returns to the page that was requested.
    window.history.pushState(null, '', `${next ? signupPath : loginPath}${window.location.search}`);
    setRegisterState(next);
  }

  return (
    <main className="auth-page">
      <div className="auth-showcase" aria-hidden="true">
        <div className="showcase-phone showcase-back">
          <div className="showcase-tile tile-a" />
          <div className="showcase-tile tile-b" />
          <div className="showcase-tile tile-c" />
          <div className="showcase-tile tile-d" />
        </div>
        <div className="showcase-phone showcase-front">
          <div className="showcase-post">
            <span className="showcase-avatar" />
            <span className="showcase-line" />
          </div>
          <div className="showcase-photo" />
          <div className="showcase-actions">
            <Heart />
            <MessageCircle />
            <Send />
          </div>
          <span className="showcase-line wide" />
          <span className="showcase-line" />
        </div>
      </div>
      <div className="auth-column">
        <section className="auth-box">
          <Wordmark className="auth-wordmark" />
          <h1 className={register ? 'auth-title' : 'sr-only'}>
            {register ? 'Sign up to see photos and videos from your friends.' : 'Log in'}
          </h1>
          <AuthForm
            key={register ? 'signup' : 'login'}
            register={register}
            onAuthenticated={onAuthenticated}
            onSubmittingChange={setSubmitting}
          />
        </section>
        <section className="auth-box auth-switch">
          <p>
            {register ? 'Have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              className="link-button"
              disabled={submitting}
              onClick={() => setRegister(!register)}
            >
              {register ? 'Log in' : 'Sign up'}
            </button>
          </p>
        </section>
      </div>
    </main>
  );
}

function AuthForm({
  register,
  onAuthenticated,
  onSubmittingChange,
}: {
  register: boolean;
  onAuthenticated: (user: User) => void;
  onSubmittingChange?: (submitting: boolean) => void;
}) {
  const [submitting, setSubmittingState] = useState(false);
  const [error, setError] = useState('');

  function setSubmitting(next: boolean) {
    setSubmittingState(next);
    onSubmittingChange?.(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const values = register
      ? {
          username: form.get('username'),
          displayName: form.get('displayName'),
          email: form.get('email'),
          password: form.get('password'),
        }
      : { email: form.get('email'), password: form.get('password') };

    try {
      const response = await request<AuthResponse>(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      onAuthenticated(response.data.user);
    } catch (submitError) {
      setError(
        userErrorMessage(submitError, 'The request could not be completed. Please try again.'),
      );
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <AuthField label="Email" name="email" type="email" autoComplete="email" />
      <AuthField
        label="Password"
        name="password"
        type="password"
        minLength={register ? 12 : 1}
        maxLength={128}
        autoComplete={register ? 'new-password' : 'current-password'}
      />
      {register && (
        <>
          <AuthField label="Full name" name="displayName" maxLength={80} autoComplete="name" />
          <AuthField
            label="Username"
            name="username"
            minLength={3}
            maxLength={30}
            autoComplete="username"
          />
          <p className="auth-fineprint">
            Passwords need at least 12 characters. Usernames can use letters, numbers, periods
            and underscores.
          </p>
        </>
      )}
      <button className="btn btn-primary btn-block" disabled={submitting}>
        {submitting ? <Spinner label="Please wait…" /> : register ? 'Sign up' : 'Log in'}
      </button>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function loginWallTitle(route: Route) {
  switch (route.name) {
    case 'profile':
      return `See more from ${route.username}`;
    case 'inbox':
      return 'Log in to see your messages';
    case 'edit':
      return 'Log in to edit your profile';
    case 'home':
      return 'Log in to Rubaagram';
  }
}

/**
 * Shown when a signed-out visitor opens an app page directly (a new window or browser
 * profile): the page stays in the address bar behind a login popup, and signing in
 * reveals it — like Instagram's "Log in to continue" dialog.
 */
function LoginWall({
  onAuthenticated,
  onSignUp,
}: {
  onAuthenticated: (user: User) => void;
  onSignUp: () => void;
}) {
  const route = parseRoute(window.location.pathname);
  const [submitting, setSubmitting] = useState(false);
  useBodyScrollLock(true);

  return (
    <div className="login-wall">
      <div className="login-wall-preview" aria-hidden="true">
        <aside className="login-wall-rail">
          <Camera />
          <House />
          <Search />
          <Send />
          <Heart />
          <SquarePlus />
        </aside>
        <div className="login-wall-content">
          <div className="login-wall-header">
            <span className="skeleton skeleton-circle login-wall-avatar" />
            <div className="login-wall-lines">
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line short" />
            </div>
          </div>
          <div className="login-wall-grid">
            {Array.from({ length: 9 }, (_, index) => (
              <span key={index} className="skeleton" />
            ))}
          </div>
        </div>
      </div>
      <div className="modal-backdrop login-wall-backdrop" role="presentation">
        <section
          className="modal login-popup"
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-popup-title"
        >
          <Wordmark className="login-popup-wordmark" />
          <h2 id="login-popup-title">{loginWallTitle(route)}</h2>
          <p className="login-popup-subtitle">
            Log in to see photos and videos from your friends.
          </p>
          <AuthForm
            register={false}
            onAuthenticated={onAuthenticated}
            onSubmittingChange={setSubmitting}
          />
          <p className="login-popup-switch">
            Don't have an account?{' '}
            <button
              type="button"
              className="link-button"
              disabled={submitting}
              onClick={onSignUp}
            >
              Sign up
            </button>
          </p>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Authenticated shell                                                 */
/* ------------------------------------------------------------------ */

type Panel = 'search' | 'notifications' | null;

function Shell({
  user,
  setUser,
  theme,
  toggleTheme,
}: {
  user: User;
  setUser: (user: User | null) => void;
  theme: Theme;
  toggleTheme: () => void;
}) {
  const { route, navigate } = useRoute();
  const toast = useToast();
  const [panel, setPanel] = useState<Panel>(null);
  const [creating, setCreating] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [messageTarget, setMessageTarget] = useState('');
  const [changingPhoto, setChangingPhoto] = useState(false);

  const [unreadMessages, setUnreadMessages] = useState(0);
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const activitySeenKey = `rubaagram-activity-seen:${user.id}`;

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);
  const closePanel = useCallback(() => setPanel(null), []);
  useEscape(closePanel, panel !== null);

  const refreshBadges = useCallback(async () => {
    try {
      const [activity, inbox] = await Promise.all([
        request<{ data: { count: number; latestAt: string | null } }>(
          '/notifications/unread-count',
        ),
        request<{ data: { unreadConversations: number; requests: number } }>(
          '/conversations/unread-count',
        ),
      ]);
      setUnreadMessages(inbox.data.unreadConversations);
      let seenAt: string | null = null;
      try {
        seenAt = window.localStorage.getItem(activitySeenKey);
      } catch {
        // Without storage the dot simply follows the unread count.
      }
      const latest = activity.data.latestAt ? Date.parse(activity.data.latestAt) : 0;
      setHasNewActivity(
        activity.data.count > 0 && (!seenAt || latest > Date.parse(seenAt)),
      );
    } catch {
      // Badges are best-effort; the next poll tries again.
    }
  }, [activitySeenKey]);

  useEffect(() => {
    void refreshBadges();
  }, [refreshBadges, route, panel]);
  usePolling(() => void refreshBadges(), 15000);

  useEffect(() => {
    if (panel !== 'notifications') return;
    setHasNewActivity(false);
    try {
      window.localStorage.setItem(activitySeenKey, new Date().toISOString());
    } catch {
      // Ignore unavailable storage.
    }
  }, [panel, activitySeenKey]);

  const go = useCallback(
    (next: Route) => {
      setPanel(null);
      setMoreOpen(false);
      navigate(next);
    },
    [navigate],
  );
  const openProfile = useCallback(
    (username: string) => go({ name: 'profile', username }),
    [go],
  );
  const togglePanel = (next: Exclude<Panel, null>) => {
    setMoreOpen(false);
    setPanel((current) => (current === next ? null : next));
  };

  async function logout() {
    setLoggingOut(true);
    try {
      await request<void>('/auth/logout', { method: 'POST' });
      window.history.replaceState(null, '', loginPath);
      setUser(null);
    } catch (logoutError) {
      setMoreOpen(false);
      toast(userErrorMessage(logoutError, 'Unable to log out. Please try again.'), 'error');
      setLoggingOut(false);
    }
  }

  const isOwnProfile = route.name === 'profile' && route.username === user.username;
  const compact = panel !== null || route.name === 'inbox';
  const navItems: Array<{
    key: string;
    label: string;
    icon: ReactNode;
    active: boolean;
    onClick: () => void;
    expanded?: boolean;
    className?: string;
    badge?: { count?: number; label: string };
  }> = [
    {
      key: 'home',
      label: 'Home',
      icon: <House aria-hidden="true" />,
      active: panel === null && route.name === 'home',
      onClick: () => go({ name: 'home' }),
    },
    {
      key: 'search',
      label: 'Search',
      icon: <Search aria-hidden="true" />,
      active: panel === 'search',
      expanded: panel === 'search',
      onClick: () => togglePanel('search'),
    },
    {
      key: 'messages',
      label: 'Messages',
      icon: <Send aria-hidden="true" />,
      active: panel === null && route.name === 'inbox',
      onClick: () => go({ name: 'inbox' }),
      badge:
        unreadMessages > 0
          ? {
              count: unreadMessages,
              label: `${unreadMessages} unread ${unreadMessages === 1 ? 'conversation' : 'conversations'}`,
            }
          : undefined,
    },
    {
      key: 'notifications',
      label: 'Notifications',
      icon: <Heart aria-hidden="true" />,
      active: panel === 'notifications',
      expanded: panel === 'notifications',
      onClick: () => togglePanel('notifications'),
      className: 'nav-desktop-only',
      badge: hasNewActivity ? { label: 'New activity' } : undefined,
    },
    {
      key: 'create',
      label: 'Create',
      icon: <SquarePlus aria-hidden="true" />,
      active: creating,
      onClick: () => {
        setPanel(null);
        setMoreOpen(false);
        setCreating(true);
      },
    },
    {
      key: 'profile',
      label: 'Profile',
      icon: <Avatar username={user.username} src={user.avatarUrl} size={24} />,
      active: panel === null && isOwnProfile,
      onClick: () => openProfile(user.username),
      className: 'nav-profile',
    },
  ];

  return (
    <div className={`app-shell ${compact ? 'is-compact' : ''}`}>
      <aside className="sidebar">
        <button
          type="button"
          className="sidebar-logo"
          aria-label="Rubaagram home"
          onClick={() => go({ name: 'home' })}
        >
          <Wordmark />
          <Camera className="sidebar-logo-icon" aria-hidden="true" />
        </button>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${item.active ? 'is-active' : ''} ${item.className ?? ''}`}
              aria-current={item.active && item.expanded === undefined ? 'page' : undefined}
              aria-expanded={item.expanded}
              aria-describedby={item.badge ? `nav-badge-${item.key}` : undefined}
              onClick={item.onClick}
            >
              <span className="nav-icon">
                {item.icon}
                {item.badge && (
                  // Hidden from the button's name; announced through aria-describedby.
                  <span
                    className={item.badge.count ? 'nav-badge' : 'nav-dot'}
                    aria-hidden="true"
                    title={item.badge.label}
                  >
                    {item.badge.count ? (item.badge.count > 9 ? '9+' : item.badge.count) : null}
                    <span className="sr-only" id={`nav-badge-${item.key}`}>
                      {item.badge.label}
                    </span>
                  </span>
                )}
              </span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          className={`nav-item nav-more ${moreOpen ? 'is-active' : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <span className="nav-icon">
            <Menu aria-hidden="true" />
          </span>
          <span className="nav-label">More</span>
        </button>
      </aside>

      {moreOpen && (
        <>
          <div className="menu-scrim" role="presentation" onMouseDown={() => setMoreOpen(false)} />
          <div className="more-menu" role="menu" aria-label="More options">
            <button
              type="button"
              role="menuitem"
              onClick={() => go({ name: 'edit' })}
            >
              <Settings aria-hidden="true" />
              Settings
            </button>
            <button type="button" role="menuitem" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              Switch appearance
            </button>
            <div className="more-menu-separator" />
            <button
              type="button"
              role="menuitem"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogOut aria-hidden="true" />
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </>
      )}

      {panel !== null && (
        <div className="drawer-scrim" role="presentation" onMouseDown={closePanel} />
      )}
      {panel === 'search' && <SearchPanel onOpenProfile={openProfile} />}
      {panel === 'notifications' && (
        <NotificationsPanel onOpenProfile={openProfile} onChanged={refresh} />
      )}

      <main className={`app-main view-${route.name}`}>
        {route.name === 'home' && (
          <HomeView
            user={user}
            refreshKey={refreshKey}
            onOpenProfile={openProfile}
            onOpenNotifications={() => togglePanel('notifications')}
            onOpenSearch={() => togglePanel('search')}
            hasNewActivity={hasNewActivity}
          />
        )}
        {route.name === 'profile' && (
          <ProfilePage
            key={route.username}
            username={route.username}
            viewer={user}
            refreshKey={refreshKey}
            onEdit={() => go({ name: 'edit' })}
            onOptions={() => setMoreOpen(true)}
            onChangePhoto={() => setChangingPhoto(true)}
            onMessage={(username) => {
              setMessageTarget(username);
              go({ name: 'inbox' });
            }}
            onOpenProfile={openProfile}
            onChanged={refresh}
          />
        )}
        {route.name === 'edit' && (
          <EditProfile
            user={user}
            setUser={setUser}
            onChanged={refresh}
            onChangePhoto={() => setChangingPhoto(true)}
          />
        )}
        {route.name === 'inbox' && (
          <MessagesPage
            currentUser={user}
            initialRecipient={messageTarget}
            onRecipientConsumed={() => setMessageTarget('')}
            onOpenProfile={openProfile}
            onReadStateChange={() => void refreshBadges()}
          />
        )}
      </main>

      {changingPhoto && (
        <ChangePhotoDialog
          user={user}
          setUser={(updated) => {
            setUser(updated);
            refresh();
          }}
          onClose={() => setChangingPhoto(false)}
        />
      )}

      {creating && (
        <CreatePostModal
          user={user}
          onClose={() => setCreating(false)}
          onPublished={refresh}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function HomeView({
  user,
  refreshKey,
  onOpenProfile,
  onOpenNotifications,
  onOpenSearch,
  hasNewActivity,
}: {
  user: User;
  refreshKey: number;
  onOpenProfile: (username: string) => void;
  onOpenNotifications: () => void;
  onOpenSearch: () => void;
  hasNewActivity: boolean;
}) {
  return (
    <div className="home">
      <header className="mobile-topbar">
        <Wordmark />
        <button
          type="button"
          className="icon-btn topbar-activity"
          aria-label={hasNewActivity ? 'Activity, new' : 'Activity'}
          onClick={onOpenNotifications}
        >
          <Heart aria-hidden="true" />
          {hasNewActivity && <span className="nav-dot" aria-hidden="true" />}
        </button>
      </header>
      <HomeFeed
        userId={user.id}
        refreshKey={refreshKey}
        onOpenProfile={onOpenProfile}
        onOpenSearch={onOpenSearch}
      />
      <aside className="home-rail">
        <button type="button" className="rail-user" onClick={() => onOpenProfile(user.username)}>
          <Avatar username={user.username} src={user.avatarUrl} size={44} />
          <span className="rail-user-text">
            <strong>{user.username}</strong>
            <span>{user.displayName}</span>
          </span>
        </button>
        <div className="rail-card">
          <p>Find people to follow and fill your feed with moments you care about.</p>
          <button type="button" className="link-button" onClick={onOpenSearch}>
            Search people
          </button>
        </div>
        <p className="rail-footer">© {new Date().getFullYear()} Rubaagram</p>
      </aside>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="feed-skeleton" aria-hidden="true">
      {[0, 1].map((item) => (
        <div className="skeleton-post" key={item}>
          <div className="skeleton-header">
            <span className="skeleton skeleton-circle" />
            <span className="skeleton skeleton-line" />
          </div>
          <span className="skeleton skeleton-media" />
        </div>
      ))}
    </div>
  );
}

function HomeFeed({
  userId,
  refreshKey,
  onOpenProfile,
  onOpenSearch,
}: {
  userId: string;
  refreshKey: number;
  onOpenProfile: (username: string) => void;
  onOpenSearch: () => void;
}) {
  const [posts, setPosts] = useState<FeedPostWithLikes[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [newPosts, setNewPosts] = useState<FeedPostWithLikes[]>([]);
  const openPost = posts.find((post) => post.id === openPostId);

  // Keep likes and comment counts live, and collect posts published since the feed loaded.
  usePolling(
    () => {
      void request<{ data: PostFeedResponse }>('/posts')
        .then((response) => {
          const latest = new Map(response.data.posts.map((post) => [post.id, post]));
          setPosts((current) => {
            const known = new Set(current.map((post) => post.id));
            const newestKnown = current[0]?.createdAt ?? '';
            setNewPosts(
              response.data.posts.filter(
                (post) => !known.has(post.id) && post.createdAt > newestKnown,
              ),
            );
            return current.map((post) => {
              const fresh = latest.get(post.id);
              return fresh
                ? {
                    ...post,
                    likeCount: fresh.likeCount,
                    likedByMe: fresh.likedByMe,
                    commentCount: fresh.commentCount,
                    authorAvatarUrl: fresh.authorAvatarUrl,
                  }
                : post;
            });
          });
        })
        .catch(() => {
          // A missed refresh is retried on the next tick.
        });
    },
    10000,
    state === 'ready',
  );

  function showNewPosts() {
    setPosts((current) => {
      const known = new Set(current.map((post) => post.id));
      return [...newPosts.filter((post) => !known.has(post.id)), ...current];
    });
    setNewPosts([]);
    document.documentElement.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  useEffect(() => {
    let active = true;
    setState('loading');
    setPosts([]);
    setNewPosts([]);
    setNextCursor(null);
    setMoreError('');

    request<{ data: PostFeedResponse }>('/posts')
      .then((response) => {
        if (!active) return;
        setPosts(response.data.posts);
        setNextCursor(response.data.nextCursor);
        setState('ready');
      })
      .catch(() => {
        if (active) setState('error');
      });

    return () => {
      active = false;
    };
  }, [userId, refreshKey, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const query = new URLSearchParams({ cursor: nextCursor });
      const response = await request<{ data: PostFeedResponse }>(`/posts?${query}`);
      setPosts((current) => [...current, ...response.data.posts]);
      setNextCursor(response.data.nextCursor);
    } catch (error) {
      setMoreError(userErrorMessage(error, 'Unable to load more posts. Please try again.'));
    } finally {
      setLoadingMore(false);
    }
  }

  const sentinel = useInfiniteScroll(() => void loadMore(), Boolean(nextCursor) && !moreError);

  function updatePost(updated: FeedPostWithLikes) {
    setPosts((current) => current.map((post) => (post.id === updated.id ? updated : post)));
  }

  return (
    <section className="feed" aria-labelledby="feed-heading">
      <h1 id="feed-heading" className="sr-only">
        Home feed
      </h1>
      {state === 'loading' && (
        <>
          <p role="status" className="sr-only">
            Loading your feed…
          </p>
          <FeedSkeleton />
        </>
      )}
      {state === 'error' && (
        <div className="empty-state">
          <p role="alert">Unable to load your feed. Please try again.</p>
          <button className="btn btn-primary" onClick={() => setRetry((attempt) => attempt + 1)}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && posts.length === 0 && (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            <Camera />
          </span>
          <h2>Your feed is quiet</h2>
          <p>Posts from public profiles will appear here.</p>
          <button type="button" className="btn btn-primary" onClick={onOpenSearch}>
            Find people
          </button>
        </div>
      )}
      {state === 'ready' && newPosts.length > 0 && (
        <div className="new-posts-row">
          <button type="button" className="new-posts-pill" onClick={showNewPosts}>
            <ArrowUp aria-hidden="true" />
            {newPosts.length === 1 ? '1 new post' : `${newPosts.length} new posts`}
          </button>
        </div>
      )}
      {state === 'ready' && posts.length > 0 && (
        <>
          <div className="feed-list">
            {posts.map((post) => (
              <FeedPostCard
                key={post.id}
                post={post}
                currentUserId={userId}
                onOpenProfile={onOpenProfile}
                onOpenPost={() => setOpenPostId(post.id)}
                onChange={updatePost}
              />
            ))}
          </div>
          {openPost && (
            <PostViewer
              post={openPost}
              currentUserId={userId}
              onClose={() => setOpenPostId(null)}
              onOpenProfile={onOpenProfile}
              onChange={updatePost}
            />
          )}
          {moreError && (
            <p className="inline-error" role="alert">
              {moreError}
            </p>
          )}
          {nextCursor && (
            <div className="load-more-row" ref={sentinel}>
              <button className="btn btn-secondary" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading more…' : moreError ? 'Retry loading more' : 'Load more'}
              </button>
            </div>
          )}
          {!nextCursor && (
            <div className="feed-end">
              <span className="feed-end-icon" aria-hidden="true">
                <CircleCheck />
              </span>
              <strong>You're all caught up</strong>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Posts                                                               */
/* ------------------------------------------------------------------ */

function Caption({
  username,
  text,
  onOpenProfile,
}: {
  username: string;
  text: string;
  onOpenProfile: (username: string) => void;
}) {
  const long = text.length > 125 || text.includes('\n');
  const [expanded, setExpanded] = useState(!long);
  return (
    <p className="caption">
      <button type="button" className="username-link" onClick={() => onOpenProfile(username)}>
        {username}
      </button>{' '}
      <span className={expanded ? 'caption-text is-expanded' : 'caption-text'}>
        {expanded ? text : `${text.slice(0, 125).split('\n')[0]}…`}
      </span>
      {!expanded && (
        <>
          {' '}
          <button type="button" className="muted-button" onClick={() => setExpanded(true)}>
            more
          </button>
        </>
      )}
    </p>
  );
}

const quickEmojis = ['😂', '😮', '😍', '😢', '👏', '🔥', '🎉', '😊', '❤️', '🙌', '💯', '😎'];

function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useEscape(close, open);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="emoji-picker" ref={container}>
      <button
        type="button"
        className="icon-btn emoji-toggle"
        aria-label="Emoji"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Smile aria-hidden="true" />
      </button>
      {open && (
        <div className="emoji-popover" role="group" aria-label="Choose an emoji">
          {quickEmojis.map((emoji) => (
            <button
              type="button"
              key={emoji}
              aria-label={`Insert ${emoji}`}
              onClick={() => {
                onPick(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  currentUserId,
  compact,
  deleting,
  deleteDisabled,
  onOpenProfile,
  onDelete,
}: {
  comment: PostComment;
  currentUserId: string;
  compact: boolean;
  deleting: boolean;
  deleteDisabled: boolean;
  onOpenProfile: (username: string) => void;
  onDelete: () => void;
}) {
  const own = comment.authorId === currentUserId;
  const deleteButton = own && (
    <button
      type="button"
      className="muted-button comment-delete"
      aria-label={`Delete comment by @${comment.authorUsername}`}
      disabled={deleteDisabled}
      onClick={onDelete}
    >
      {deleting ? 'Deleting…' : 'Delete'}
    </button>
  );

  if (compact) {
    return (
      <li className="comment comment-compact">
        <p>
          <button
            type="button"
            className="username-link"
            onClick={() => onOpenProfile(comment.authorUsername)}
          >
            {comment.authorUsername}
          </button>{' '}
          {comment.text}
        </p>
        {deleteButton}
      </li>
    );
  }

  return (
    <li className="comment">
      <button
        type="button"
        className="comment-avatar"
        aria-label={`Open ${comment.authorUsername}'s profile`}
        onClick={() => onOpenProfile(comment.authorUsername)}
      >
        <Avatar username={comment.authorUsername} src={comment.authorAvatarUrl} size={32} />
      </button>
      <div className="comment-body">
        <p>
          <button
            type="button"
            className="username-link"
            onClick={() => onOpenProfile(comment.authorUsername)}
          >
            {comment.authorUsername}
          </button>{' '}
          {comment.text}
        </p>
        <div className="comment-meta">
          <time dateTime={comment.createdAt} title={fullDate(comment.createdAt)}>
            {timeAgo(comment.createdAt)}
          </time>
          {deleteButton}
        </div>
      </div>
    </li>
  );
}

function FeedPostCard({
  post,
  currentUserId,
  onOpenProfile,
  variant = 'feed',
  onChange,
  onOpenPost,
}: {
  post: FeedPostWithLikes;
  currentUserId: string;
  onOpenProfile: (username: string) => void;
  variant?: 'feed' | 'modal';
  onChange?: (post: FeedPostWithLikes) => void;
  /** Opens the full post viewer with every comment (feed cards only). */
  onOpenPost?: () => void;
}) {
  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [liking, setLiking] = useState(false);
  const [likeError, setLikeError] = useState('');
  const [burst, setBurst] = useState(0);
  // In the feed this only holds comments written from this card; the viewer loads them all.
  const [comments, setComments] = useState<PostComment[]>([]);
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null);
  const [commentsState, setCommentsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [commentsError, setCommentsError] = useState('');
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentRequestKey, setCommentRequestKey] = useState<string | null>(null);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentMutationError, setCommentMutationError] = useState('');
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const commentInput = useRef<HTMLTextAreaElement | null>(null);
  const isModal = variant === 'modal';

  useEffect(() => {
    setLiked(post.likedByMe);
    setLikeCount(post.likeCount);
  }, [post.likedByMe, post.likeCount]);

  useEffect(() => {
    if (isModal) void loadComments();
    // Load once when the post viewer opens.
  }, []);

  // While the viewer is open, pull in comments other people post.
  usePolling(
    () => {
      void request<{ data: PostCommentsResponse }>(`/posts/${post.id}/comments`)
        .then((response) => {
          const fresh = response.data.comments;
          const freshIds = new Set(fresh.map((comment) => comment.id));
          const oldestFresh = fresh[fresh.length - 1]?.createdAt;
          setComments((current) => [
            ...fresh,
            // Keep older pages the viewer already loaded.
            ...current.filter(
              (comment) =>
                !freshIds.has(comment.id) &&
                oldestFresh !== undefined &&
                comment.createdAt < oldestFresh,
            ),
          ]);
        })
        .catch(() => {
          // Retried on the next tick.
        });
    },
    5000,
    isModal && commentsState === 'ready' && !submittingComment && deletingCommentId === null,
  );

  function changeCommentCount(delta: number) {
    if (post.commentCount === undefined) return;
    onChange?.({
      ...post,
      likedByMe: liked,
      likeCount,
      commentCount: Math.max(0, post.commentCount + delta),
    });
  }

  useEffect(() => {
    const input = commentInput.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 80)}px`;
  }, [commentDraft]);

  async function toggleLike() {
    if (liking) return;
    setLiking(true);
    setLikeError('');
    try {
      const response = await request<{ data: PostLikeState }>(`/posts/${post.id}/like`, {
        method: liked ? 'DELETE' : 'PUT',
      });
      setLiked(response.data.liked);
      setLikeCount(response.data.likeCount);
      onChange?.({ ...post, likedByMe: response.data.liked, likeCount: response.data.likeCount });
    } catch (error) {
      setLikeError(userErrorMessage(error, 'Unable to update your like. Please try again.'));
    } finally {
      setLiking(false);
    }
  }

  function likeFromImage() {
    setBurst((current) => current + 1);
    if (!liked) void toggleLike();
  }

  async function loadComments(cursor?: string) {
    setCommentsError('');
    setCommentsState(cursor ? 'ready' : 'loading');
    if (cursor) setLoadingMoreComments(true);
    try {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
      const response = await request<{ data: PostCommentsResponse }>(
        `/posts/${post.id}/comments${query}`,
      );
      setComments((current) =>
        cursor ? [...current, ...response.data.comments] : response.data.comments,
      );
      setCommentsCursor(response.data.nextCursor);
      setCommentsState('ready');
    } catch (error) {
      const message = userErrorMessage(error, 'Unable to load comments. Please try again.');
      setCommentsError(message);
      if (!cursor) setCommentsState('error');
    } finally {
      setLoadingMoreComments(false);
    }
  }

  function onCommentIcon() {
    if (!isModal && onOpenPost) onOpenPost();
    else commentInput.current?.focus();
  }

  async function submitComment(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (submittingComment || !commentDraft.trim()) return;
    setCommentMutationError('');
    setSubmittingComment(true);
    const idempotencyKey = commentRequestKey ?? window.crypto.randomUUID();
    setCommentRequestKey(idempotencyKey);
    try {
      const response = await request<{ data: { comment: PostComment } }>(
        `/posts/${post.id}/comments`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ text: commentDraft }),
        },
      );
      setComments((current) =>
        isModal ? [response.data.comment, ...current] : [...current, response.data.comment],
      );
      setCommentDraft('');
      setCommentRequestKey(null);
      if (isModal) setCommentsState('ready');
      changeCommentCount(1);
    } catch (error) {
      setCommentMutationError(
        userErrorMessage(error, 'Unable to add your comment. Please try again.'),
      );
    } finally {
      setSubmittingComment(false);
    }
  }

  async function deleteComment(commentId: string) {
    if (deletingCommentId) return;
    setDeletingCommentId(commentId);
    setCommentMutationError('');
    try {
      await request<void>(`/posts/${post.id}/comments/${commentId}`, { method: 'DELETE' });
      setComments((current) => current.filter((comment) => comment.id !== commentId));
      changeCommentCount(-1);
    } catch (error) {
      setCommentMutationError(
        userErrorMessage(error, 'Unable to delete your comment. Please try again.'),
      );
    } finally {
      setDeletingCommentId(null);
    }
  }

  function onCommentKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitComment();
    }
  }

  function insertEmoji(emoji: string) {
    const input = commentInput.current;
    const start = input?.selectionStart ?? commentDraft.length;
    const end = input?.selectionEnd ?? commentDraft.length;
    const next = `${commentDraft.slice(0, start)}${emoji}${commentDraft.slice(end)}`;
    if (next.length > 1000) return;
    setCommentDraft(next);
    setCommentRequestKey(null);
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  const renderComments = (compact: boolean) => (
    <ul className={`comment-list ${compact ? 'is-compact' : ''}`}>
      {comments.map((comment) => (
        <CommentRow
          key={comment.id}
          comment={comment}
          currentUserId={currentUserId}
          compact={compact}
          deleting={deletingCommentId === comment.id}
          deleteDisabled={deletingCommentId !== null}
          onOpenProfile={onOpenProfile}
          onDelete={() => void deleteComment(comment.id)}
        />
      ))}
    </ul>
  );

  const header = (
    <header className="post-header">
      <button
        type="button"
        className="post-author"
        onClick={() => onOpenProfile(post.authorUsername)}
        aria-label={`Open ${post.authorUsername}'s profile`}
      >
        <Avatar username={post.authorUsername} src={post.authorAvatarUrl} size={32} />
      </button>
      <div className="post-meta">
        <button
          type="button"
          className="username-link"
          onClick={() => onOpenProfile(post.authorUsername)}
        >
          {post.authorUsername}
        </button>
        <span className="dot" aria-hidden="true">
          •
        </span>
        <time dateTime={post.createdAt} title={fullDate(post.createdAt)}>
          {timeAgo(post.createdAt)}
        </time>
      </div>
    </header>
  );

  const media = (
    <div className="post-media" onDoubleClick={likeFromImage}>
      <PostImage
        className="post-image"
        src={post.imageUrl}
        alt={`Post by @${post.authorUsername}`}
      />
      {burst > 0 && (
        <span key={burst} className="like-burst" aria-hidden="true">
          <Heart fill="currentColor" />
        </span>
      )}
    </div>
  );

  const actions = (
    <>
      <div className="post-actions">
        <button
          type="button"
          className={`icon-btn like-button ${liked ? 'is-liked' : ''}`}
          aria-label={liking ? 'Updating like…' : liked ? 'Unlike' : 'Like'}
          aria-pressed={liked}
          disabled={liking}
          onClick={toggleLike}
        >
          <Heart aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
        </button>
        <button type="button" className="icon-btn" aria-label="Comment" onClick={onCommentIcon}>
          <MessageCircle aria-hidden="true" className="flip-x" />
        </button>
      </div>
      <p className="post-likes" aria-live="polite">
        {likeCount === 0 && isModal ? (
          <span className="post-likes-empty">
            Be the first to{' '}
            <button type="button" className="username-link" onClick={toggleLike}>
              like this
            </button>
          </span>
        ) : (
          plural(likeCount, 'like', 'likes')
        )}
      </p>
      {likeError && (
        <p className="inline-error" role="alert">
          {likeError}
        </p>
      )}
    </>
  );

  const commentForm = (
    <form className="comment-form" onSubmit={submitComment}>
      {commentMutationError && (
        <p className="inline-error" role="alert">
          {commentMutationError}
        </p>
      )}
      <div className="comment-form-row">
        {isModal && <EmojiPicker onPick={insertEmoji} />}
        <textarea
          ref={commentInput}
          aria-label="Add a comment"
          placeholder="Add a comment…"
          rows={1}
          value={commentDraft}
          maxLength={1000}
          onKeyDown={onCommentKeyDown}
          onChange={(event) => {
            setCommentDraft(event.currentTarget.value);
            setCommentRequestKey(null);
          }}
        />
        {(commentDraft.trim() || submittingComment) && (
          <button
            type="submit"
            className="text-button"
            aria-label={submittingComment ? 'Posting comment…' : 'Post comment'}
            disabled={submittingComment || !commentDraft.trim()}
          >
            {submittingComment ? <Spinner size={14} /> : 'Post'}
          </button>
        )}
        {!isModal && <EmojiPicker onPick={insertEmoji} />}
      </div>
    </form>
  );

  if (isModal) {
    return (
      <article className="post post-modal">
        {media}
        <div className="post-modal-side">
          {header}
          <div className="post-modal-scroll">
            <div className="comment comment-caption">
              <Avatar username={post.authorUsername} src={post.authorAvatarUrl} size={32} />
              <div className="comment-body">
                <Caption
                  username={post.authorUsername}
                  text={post.caption}
                  onOpenProfile={onOpenProfile}
                />
                <div className="comment-meta">
                  <time dateTime={post.createdAt} title={fullDate(post.createdAt)}>
                    {timeAgo(post.createdAt)}
                  </time>
                </div>
              </div>
            </div>
            <section className="comments" id={`comments-${post.id}`} aria-label="Comments">
              {commentsState === 'loading' && (
                <p role="status" className="comments-status">
                  <Spinner /> Loading comments…
                </p>
              )}
              {commentsState === 'error' && (
                <div className="comments-status">
                  <p role="alert">{commentsError}</p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void loadComments()}
                  >
                    Retry comments
                  </button>
                </div>
              )}
              {commentsState === 'ready' && comments.length === 0 && (
                <div className="comments-empty">
                  <strong>No comments yet.</strong>
                  <span>Start the conversation.</span>
                </div>
              )}
              {commentsState === 'ready' && comments.length > 0 && renderComments(false)}
              {commentsError && commentsState === 'ready' && (
                <p className="inline-error" role="alert">
                  {commentsError}
                </p>
              )}
              {commentsCursor && commentsState === 'ready' && (
                <button
                  type="button"
                  className="load-comments"
                  aria-label={loadingMoreComments ? 'Loading comments…' : 'View more comments'}
                  disabled={loadingMoreComments}
                  onClick={() => void loadComments(commentsCursor)}
                >
                  {loadingMoreComments ? <Spinner size={16} /> : <SquarePlus aria-hidden="true" />}
                </button>
              )}
            </section>
          </div>
          <div className="post-modal-footer">
            {actions}
            <time
              className="post-modal-date"
              dateTime={post.createdAt}
              title={fullDate(post.createdAt)}
            >
              {new Date(post.createdAt).toLocaleDateString(undefined, {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </time>
            {commentForm}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="post">
      {header}
      {media}
      {actions}
      <Caption username={post.authorUsername} text={post.caption} onOpenProfile={onOpenProfile} />
      {onOpenPost && post.commentCount !== 0 && (
        <button type="button" className="muted-button view-comments" onClick={onOpenPost}>
          {post.commentCount === undefined
            ? 'View comments'
            : post.commentCount === 1
              ? 'View 1 comment'
              : `View all ${formatCount(post.commentCount)} comments`}
        </button>
      )}
      {comments.length > 0 && renderComments(true)}
      {commentForm}
    </article>
  );
}

function PostViewer({
  post,
  currentUserId,
  onClose,
  onOpenProfile,
  onChange,
}: {
  post: FeedPostWithLikes;
  currentUserId: string;
  onClose: () => void;
  onOpenProfile: (username: string) => void;
  onChange: (post: FeedPostWithLikes) => void;
}) {
  return (
    <Modal labelledBy={`post-viewer-${post.id}`} onClose={onClose} className="post-viewer">
      <h2 id={`post-viewer-${post.id}`} className="sr-only">
        Post by {post.authorUsername}
      </h2>
      <FeedPostCard
        post={post}
        currentUserId={currentUserId}
        onOpenProfile={(username) => {
          onClose();
          onOpenProfile(username);
        }}
        variant="modal"
        onChange={onChange}
      />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Create post                                                         */
/* ------------------------------------------------------------------ */

const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

function CreatePostModal({
  user,
  onClose,
  onPublished,
}: {
  user: User;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [image, setImage] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [postError, setPostError] = useState('');
  const [createdPost, setCreatedPost] = useState<PostResponse | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const previewUrl = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const requestClose = useCallback(() => {
    if (uploading) return;
    if (image && !createdPost) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [uploading, image, createdPost, onClose]);

  function chooseFile(file: File | undefined | null) {
    setPostError('');
    if (!file) return;
    if (!acceptedImageTypes.includes(file.type)) {
      setPostError('Choose a valid JPEG, PNG, or WebP image.');
      return;
    }
    setImage(file);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  }

  async function createPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPostError('');
    if (!image || !caption.trim()) {
      setPostError('Choose an image and add a caption before sharing.');
      return;
    }
    setUploading(true);
    try {
      const body = new window.FormData();
      body.append('image', image, image.name);
      body.append('caption', caption);
      const response = await request<{ data: { post: PostResponse } }>('/posts', {
        method: 'POST',
        body,
      });
      setCreatedPost(response.data.post);
      onPublished();
    } catch (postFailure) {
      setPostError(
        userErrorMessage(postFailure, 'The post could not be published. Please try again.'),
      );
    } finally {
      setUploading(false);
    }
  }

  const step = createdPost ? 'done' : image ? 'compose' : 'select';

  return (
    <>
      <Modal
        labelledBy="create-post-title"
        onClose={requestClose}
        className={`create-modal create-${step}`}
        closeLabel="Close create post"
      >
        <form className="create-form" noValidate onSubmit={createPost}>
          <header className="modal-header">
            {step === 'compose' ? (
              <button
                type="button"
                className="icon-btn"
                aria-label="Back"
                disabled={uploading}
                onClick={() => setConfirmDiscard(true)}
              >
                <ArrowLeft aria-hidden="true" />
              </button>
            ) : (
              <span className="modal-header-spacer" />
            )}
            <h2 id="create-post-title">
              {step === 'done' ? 'Post shared' : 'Create new post'}
            </h2>
            {step === 'compose' ? (
              <button
                type="submit"
                className="text-button"
                aria-label={uploading ? 'Uploading…' : 'Share post'}
                disabled={uploading || !image}
              >
                {uploading ? <Spinner size={16} /> : 'Share'}
              </button>
            ) : (
              <span className="modal-header-spacer" />
            )}
          </header>

          {step === 'select' && (
            <label
              className={`create-dropzone ${dragging ? 'is-dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <Images className="create-dropzone-icon" aria-hidden="true" />
              <span className="create-dropzone-title">Drag photos here</span>
              <span className="btn btn-primary">Select from computer</span>
              <span className="create-dropzone-hint">JPG, PNG or WebP · up to 8 MB</span>
              <input
                className="sr-only"
                name="image"
                type="file"
                accept={acceptedImageTypes.join(',')}
                aria-label="Image"
                onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
              />
              {postError && (
                <span className="inline-error" role="alert">
                  {postError}
                </span>
              )}
            </label>
          )}

          {step === 'compose' && previewUrl && (
            <div className="create-compose">
              <div className="create-preview">
                <img src={previewUrl} alt="Selected image preview" />
              </div>
              <div className="create-details">
                <div className="create-author">
                  <Avatar username={user.username} src={user.avatarUrl} size={28} />
                  <strong>{user.username}</strong>
                </div>
                <textarea
                  name="caption"
                  aria-label="Caption"
                  className="create-caption"
                  maxLength={2200}
                  placeholder="Write a caption…"
                  value={caption}
                  autoFocus
                  onChange={(event) => setCaption(event.currentTarget.value)}
                />
                <p className="create-counter">{caption.length.toLocaleString()}/2,200</p>
                {postError && (
                  <p className="inline-error" role="alert">
                    {postError}
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 'done' && createdPost && (
            <div className="create-done">
              <span className="create-done-badge" aria-hidden="true">
                <CircleCheck />
              </span>
              <p role="status" className="create-done-title">
                Your post has been shared.
              </p>
              <PostImage src={createdPost.imageUrl} alt="Your published post" />
              <p className="create-done-caption">{createdPost.caption}</p>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          )}
        </form>
      </Modal>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard post?"
          body="If you leave, your edits won't be saved."
          confirmLabel="Discard"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            setImage(null);
            setCaption('');
            setPostError('');
            onClose();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function followStateLabel(state: FollowState) {
  if (state === 'following') return 'Following';
  if (state === 'pending') return 'Requested';
  return '';
}

function SearchPanel({ onOpenProfile }: { onOpenProfile: (username: string) => void }) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [profiles, setProfiles] = useState<DiscoveredProfile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const searchId = useRef(0);

  const search = useCallback(async (nextQuery: string) => {
    const normalized = nextQuery.trim();
    if (normalized.length < 2 || normalized.length > 30) return;
    searchId.current += 1;
    const id = searchId.current;
    setActiveQuery(normalized);
    setProfiles([]);
    setCursor(null);
    setError('');
    setState('loading');
    try {
      const params = new URLSearchParams({ q: normalized });
      const response = await request<{ data: UserDiscoveryResponse }>(
        `/users/discover?${params}`,
      );
      if (id !== searchId.current) return;
      setProfiles(response.data.users);
      setCursor(response.data.nextCursor);
      setState('ready');
    } catch (searchError) {
      if (id !== searchId.current) return;
      setError(userErrorMessage(searchError, 'Unable to search profiles. Please try again.'));
      setState('error');
    }
  }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      searchId.current += 1;
      setState('idle');
      setProfiles([]);
      setCursor(null);
      return;
    }
    if (!/^[a-zA-Z0-9._]+$/.test(normalized)) return;
    const timer = window.setTimeout(() => void search(normalized), 300);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: activeQuery, cursor });
      const response = await request<{ data: UserDiscoveryResponse }>(
        `/users/discover?${params}`,
      );
      setProfiles((current) => [...current, ...response.data.users]);
      setCursor(response.data.nextCursor);
    } catch (searchError) {
      setError(userErrorMessage(searchError, 'Unable to load more profiles. Please try again.'));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <aside className="drawer" aria-labelledby="search-heading">
      <h2 id="search-heading" className="drawer-title">
        Search
      </h2>
      <form
        className="search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <Search className="search-icon" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label="Search usernames"
          placeholder="Search"
          maxLength={30}
          autoComplete="off"
          autoFocus
          spellCheck={false}
        />
        {state === 'loading' ? (
          <Spinner size={14} />
        ) : (
          query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X aria-hidden="true" />
            </button>
          )
        )}
      </form>
      <div className="drawer-body">
        {state === 'idle' && (
          <p className="drawer-hint">Search for people by username.</p>
        )}
        {state === 'loading' && (
          <p role="status" className="drawer-hint">
            Searching profiles…
          </p>
        )}
        {state === 'error' && (
          <div className="drawer-hint">
            <p role="alert">{error}</p>
            <button type="button" className="link-button" onClick={() => void search(activeQuery)}>
              Retry search
            </button>
          </div>
        )}
        {state === 'ready' && profiles.length === 0 && (
          <p className="drawer-hint">No profiles found.</p>
        )}
        {state === 'ready' && profiles.length > 0 && (
          <>
            <ul className="people-list">
              {profiles.map((profile) => (
                <li key={profile.username}>
                  <button
                    type="button"
                    className="person-row"
                    onClick={() => onOpenProfile(profile.username)}
                  >
                    <Avatar username={profile.username} src={profile.avatarUrl} size={44} />
                    <span className="person-text">
                      <strong>
                        {profile.username}
                        {profile.isPrivate && (
                          <Lock className="inline-icon" aria-label="Private" />
                        )}
                      </strong>
                      <span>
                        {[profile.displayName, followStateLabel(profile.followState)]
                          .filter(Boolean)
                          .join(' • ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            {cursor && (
              <button
                type="button"
                className="link-button drawer-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : error ? 'Retry loading profiles' : 'Load more profiles'}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function notificationDescription(type: Notification['type']) {
  switch (type) {
    case 'like':
      return 'liked your post.';
    case 'comment':
      return 'commented on your post.';
    case 'follow':
      return 'started following you.';
    case 'follow_request':
      return 'requested to follow you.';
    case 'follow_approved':
      return 'accepted your follow request.';
  }
}

function notificationGroup(iso: string, now = Date.now()) {
  const days = (now - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return 'Today';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Earlier';
}

function NotificationsPanel({
  onOpenProfile,
  onChanged,
}: {
  onOpenProfile: (username: string) => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<'activity' | 'requests'>('activity');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [actionError, setActionError] = useState('');
  const [markingId, setMarkingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setState('loading');
    setError('');
    setMoreError('');
    setActionError('');
    request<{ data: NotificationsResponse }>('/notifications?limit=20')
      .then((response) => {
        if (!active) return;
        setNotifications(response.data.notifications);
        setCursor(response.data.nextCursor);
        setState('ready');
      })
      .catch((loadError) => {
        if (active) {
          setError(
            userErrorMessage(loadError, 'Unable to load notifications. Please try again.'),
          );
          setState('error');
        }
      });
    return () => {
      active = false;
    };
  }, [retry]);

  // New likes, comments and follows show up while the panel is open.
  usePolling(
    () => {
      void request<{ data: NotificationsResponse }>('/notifications?limit=20')
        .then((response) => {
          const fresh = response.data.notifications;
          const freshIds = new Set(fresh.map((notification) => notification.id));
          setNotifications((current) => [
            ...fresh,
            ...current.filter((notification) => !freshIds.has(notification.id)),
          ]);
        })
        .catch(() => {
          // Retried on the next tick.
        });
    },
    10000,
    state === 'ready' && view === 'activity' && markingId === null && !loadingMore,
  );

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const params = new URLSearchParams({ limit: '20', cursor });
      const response = await request<{ data: NotificationsResponse }>(
        `/notifications?${params}`,
      );
      setNotifications((current) => [...current, ...response.data.notifications]);
      setCursor(response.data.nextCursor);
    } catch (loadError) {
      setMoreError(
        userErrorMessage(loadError, 'Unable to load more notifications. Please try again.'),
      );
    } finally {
      setLoadingMore(false);
    }
  }

  async function markRead(notificationId: string) {
    if (markingId) return;
    setMarkingId(notificationId);
    setActionError('');
    try {
      const response = await request<{ data: { readAt: string | null } }>(
        `/notifications/${notificationId}/read`,
        { method: 'PUT' },
      );
      setNotifications((current) =>
        current.map((notification) =>
          notification.id === notificationId
            ? { ...notification, readAt: response.data.readAt }
            : notification,
        ),
      );
    } catch (markError) {
      setActionError(
        userErrorMessage(markError, 'Unable to mark this notification as read. Please try again.'),
      );
    } finally {
      setMarkingId(null);
    }
  }

  if (view === 'requests') {
    return (
      <aside className="drawer" aria-labelledby="follow-requests-heading">
        <FollowRequests
          onBack={() => setView('activity')}
          onOpenProfile={onOpenProfile}
          onChanged={onChanged}
        />
      </aside>
    );
  }

  const groups: Array<{ title: string; items: Notification[] }> = [];
  for (const notification of notifications) {
    const title = notificationGroup(notification.createdAt);
    const group = groups.find((item) => item.title === title);
    if (group) group.items.push(notification);
    else groups.push({ title, items: [notification] });
  }

  return (
    <aside className="drawer" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="drawer-title">
        Notifications
      </h2>
      <div className="drawer-body">
        <button
          type="button"
          className="follow-requests-row"
          aria-label="Follow requests"
          onClick={() => setView('requests')}
        >
          <span className="follow-requests-icon" aria-hidden="true">
            <UserPlus />
          </span>
          <span className="person-text">
            <strong>Follow requests</strong>
            <span>Approve or ignore requests</span>
          </span>
          <ChevronRight aria-hidden="true" className="row-chevron" />
        </button>
        {state === 'loading' && (
          <p role="status" className="drawer-hint">
            Loading notifications…
          </p>
        )}
        {state === 'error' && (
          <div className="drawer-hint">
            <p role="alert">{error}</p>
            <button
              type="button"
              className="link-button"
              onClick={() => setRetry((attempt) => attempt + 1)}
            >
              Retry notifications
            </button>
          </div>
        )}
        {state === 'ready' && notifications.length === 0 && (
          <div className="drawer-empty">
            <span className="empty-icon" aria-hidden="true">
              <Heart />
            </span>
            <p>You have no notifications yet.</p>
            <span>When someone likes or comments on your posts, you'll see it here.</span>
          </div>
        )}
        {state === 'ready' &&
          groups.map((group) => (
            <section key={group.title} className="notification-group">
              <h3>{group.title}</h3>
              <ul className="notification-list">
                {group.items.map((notification) => (
                  <li
                    className={`notification ${notification.readAt ? 'is-read' : 'is-unread'}`}
                    key={notification.id}
                    aria-label={notification.readAt ? 'Read notification' : 'Unread notification'}
                  >
                    <button
                      type="button"
                      className="notification-avatar"
                      aria-label={`Open ${notification.actorUsername}'s profile`}
                      onClick={() => onOpenProfile(notification.actorUsername)}
                    >
                      <Avatar
                        username={notification.actorUsername}
                        src={notification.actorAvatarUrl}
                        size={44}
                      />
                    </button>
                    <p className="notification-text">
                      <button
                        type="button"
                        className="username-link"
                        onClick={() => onOpenProfile(notification.actorUsername)}
                      >
                        {notification.actorUsername}
                      </button>{' '}
                      {notificationDescription(notification.type)}{' '}
                      <time dateTime={notification.createdAt} title={fullDate(notification.createdAt)}>
                        {timeAgo(notification.createdAt)}
                      </time>
                    </p>
                    {notification.resourceUrl && (
                      <a
                        className="notification-thumb"
                        href={`${api}${notification.resourceUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="View post"
                      >
                        <PostImage src={notification.resourceUrl} alt="" compact />
                      </a>
                    )}
                    {!notification.readAt && (
                      <button
                        type="button"
                        className="unread-dot"
                        aria-label={markingId === notification.id ? 'Updating…' : 'Mark as read'}
                        title="Mark as read"
                        disabled={markingId !== null}
                        onClick={() => void markRead(notification.id)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {moreError && state === 'ready' && (
          <p className="inline-error" role="alert">
            {moreError}
          </p>
        )}
        {actionError && state === 'ready' && (
          <p className="inline-error" role="alert">
            {actionError}
          </p>
        )}
        {cursor && state === 'ready' && (
          <button
            type="button"
            className="link-button drawer-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore
              ? 'Loading more…'
              : moreError
                ? 'Retry loading more'
                : 'Load more notifications'}
          </button>
        )}
      </div>
    </aside>
  );
}

function FollowRequests({
  onBack,
  onOpenProfile,
  onChanged,
}: {
  onBack: () => void;
  onOpenProfile: (username: string) => void;
  onChanged: () => void;
}) {
  const [followRequests, setFollowRequests] = useState<
    Array<{ id: string; username: string; displayName: string; avatarUrl?: string | null }>
  >([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState('');
  const [requestActionId, setRequestActionId] = useState('');

  const loadFollowRequests = useCallback(async () => {
    setRequestsLoading(true);
    setRequestsError('');
    try {
      const response = await request<{
        data: { requests: Array<{ id: string; username: string; displayName: string; avatarUrl?: string | null }> };
      }>('/users/me/follow-requests');
      setFollowRequests(response.data.requests);
    } catch (requestError) {
      setRequestsError(userErrorMessage(requestError, 'Unable to load follow requests.'));
    } finally {
      setRequestsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFollowRequests();
  }, [loadFollowRequests]);

  async function handleFollowRequest(id: string, action: 'approve' | 'reject') {
    if (requestActionId) return;
    setRequestActionId(id);
    setRequestsError('');
    try {
      await request<void>(`/users/follow-requests/${id}${action === 'approve' ? '/approve' : ''}`, {
        method: action === 'approve' ? 'PUT' : 'DELETE',
      });
      await loadFollowRequests();
      onChanged();
    } catch (requestError) {
      setRequestsError(userErrorMessage(requestError, 'Unable to update this follow request.'));
    } finally {
      setRequestActionId('');
    }
  }

  return (
    <>
      <header className="drawer-subheader">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <h2 id="follow-requests-heading">Follow requests</h2>
        <span className="modal-header-spacer" />
      </header>
      <section className="drawer-body" aria-label="Pending follow requests">
        {requestsLoading && (
          <p role="status" className="drawer-hint">
            Loading follow requests…
          </p>
        )}
        {requestsError && (
          <p className="inline-error" role="alert">
            {requestsError}
          </p>
        )}
        {!requestsLoading && !requestsError && followRequests.length === 0 && (
          <p className="drawer-hint">No pending follow requests.</p>
        )}
        <ul className="people-list">
          {followRequests.map((followRequest) => (
            <li className="request-row" key={followRequest.id}>
              <button
                type="button"
                className="person-row"
                onClick={() => onOpenProfile(followRequest.username)}
              >
                <Avatar username={followRequest.username} src={followRequest.avatarUrl} size={44} />
                <span className="person-text">
                  <strong>{followRequest.username}</strong>
                  <span>{followRequest.displayName}</span>
                </span>
              </button>
              <div className="request-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={requestActionId !== ''}
                  onClick={() => void handleFollowRequest(followRequest.id, 'approve')}
                >
                  {requestActionId === followRequest.id ? 'Updating…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={requestActionId !== ''}
                  onClick={() => void handleFollowRequest(followRequest.id, 'reject')}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

function ProfilePage({
  username,
  viewer,
  refreshKey,
  onEdit,
  onOptions,
  onChangePhoto,
  onMessage,
  onOpenProfile,
  onChanged,
}: {
  username: string;
  viewer: User;
  refreshKey: number;
  onEdit: () => void;
  onOptions: () => void;
  onChangePhoto: () => void;
  onMessage: (username: string) => void;
  onOpenProfile: (username: string) => void;
  onChanged: () => void;
}) {
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [posts, setPosts] = useState<FeedPostWithLikes[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [confirmUnfollow, setConfirmUnfollow] = useState(false);
  const [openPost, setOpenPost] = useState<FeedPostWithLikes | null>(null);
  const viewerUsername = viewer.username;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setPosts([]);
    setCursor(null);

    let profileLoaded = false;
    request<{ data: { user: ProfileSummary } }>(
      `/users?username=${encodeURIComponent(username)}`,
    )
      .then(async (response) => {
        if (!active) return;
        const loadedProfile = response.data.user;
        profileLoaded = true;
        setProfile(loadedProfile);
        const ownProfile = loadedProfile.username === viewerUsername;
        if (loadedProfile.isPrivate && !ownProfile && loadedProfile.followState !== 'following') {
          setPosts([]);
          return;
        }
        const params = new URLSearchParams({ limit: '20' });
        const postsResponse = await request<{ data: PostFeedResponse }>(
          `/users/${encodeURIComponent(username)}/posts?${params}`,
        );
        if (active) {
          setPosts(postsResponse.data.posts);
          setCursor(postsResponse.data.nextCursor);
        }
      })
      .catch((pageError) => {
        if (active) {
          // Keep a loaded profile on screen when only its posts fail.
          if (!profileLoaded) setProfile(null);
          setError(userErrorMessage(pageError, 'Unable to load this profile. Please try again.'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [username, viewerUsername, retry, refreshKey]);

  async function toggleFollow() {
    if (!profile || updating) return;
    setConfirmUnfollow(false);
    setUpdating(true);
    setError('');
    try {
      const response = await request<{ data: { followState: FollowState } }>(
        `/users/${encodeURIComponent(profile.username)}/follow`,
        { method: profile.followState === 'none' ? 'PUT' : 'DELETE' },
      );
      setProfile((current) =>
        current
          ? {
              ...current,
              followState: response.data.followState,
              followerCount:
                current.followerCount === null
                  ? null
                  : current.followerCount +
                    Number(response.data.followState === 'following') -
                    Number(current.followState === 'following'),
            }
          : current,
      );
      if (response.data.followState === 'following' || !profile.isPrivate) {
        setRetry((attempt) => attempt + 1);
      } else {
        setPosts([]);
        setCursor(null);
      }
      onChanged();
    } catch (followError) {
      setError(userErrorMessage(followError, 'Unable to update this follow. Please try again.'));
    } finally {
      setUpdating(false);
    }
  }

  async function loadMorePosts() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const params = new URLSearchParams({ limit: '20', cursor });
      const response = await request<{ data: PostFeedResponse }>(
        `/users/${encodeURIComponent(username)}/posts?${params}`,
      );
      setPosts((current) => [...current, ...response.data.posts]);
      setCursor(response.data.nextCursor);
    } catch (pageError) {
      setMoreError(userErrorMessage(pageError, 'Unable to load more posts. Please try again.'));
    } finally {
      setLoadingMore(false);
    }
  }

  const sentinel = useInfiniteScroll(() => void loadMorePosts(), Boolean(cursor) && !moreError);
  const isOwnProfile = profile?.username === viewerUsername;
  const privatePreview =
    profile?.isPrivate && !isOwnProfile && profile.followState !== 'following';
  const avatarUrl = isOwnProfile ? viewer.avatarUrl : profile?.avatarUrl;

  if (loading && !profile) {
    return (
      <section className="profile" aria-label={username}>
        <p role="status" className="page-status">
          <Spinner /> Loading profile…
        </p>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="profile" aria-label={username}>
        <div className="empty-state">
          <h2>Sorry, this page isn't available.</h2>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setRetry((attempt) => attempt + 1)}
          >
            Retry profile
          </button>
        </div>
      </section>
    );
  }

  const followLabel =
    profile.followState === 'following'
      ? `Unfollow @${profile.username}`
      : profile.followState === 'pending'
        ? `Cancel follow request to @${profile.username}`
        : `Follow @${profile.username}`;

  return (
    <section className="profile" aria-labelledby="profile-heading">
      <header className="profile-header">
        <div className="profile-avatar">
          {isOwnProfile ? (
            <button
              type="button"
              className="profile-avatar-button"
              aria-label="Change profile photo"
              title="Change profile photo"
              onClick={onChangePhoto}
            >
              <Avatar username={profile.username} src={avatarUrl} size={150} />
            </button>
          ) : (
            <Avatar username={profile.username} src={avatarUrl} size={150} />
          )}
        </div>
        <div className="profile-info">
          <div className="profile-title-row">
            <h2 id="profile-heading">{profile.username}</h2>
            <div className="profile-actions">
              {isOwnProfile ? (
                <>
                  <button type="button" className="btn btn-secondary" onClick={onEdit}>
                    Edit profile
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Options"
                    onClick={onOptions}
                  >
                    <Settings aria-hidden="true" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`btn ${profile.followState === 'none' ? 'btn-primary' : 'btn-secondary'}`}
                    aria-label={followLabel}
                    disabled={updating}
                    onClick={() => {
                      if (profile.followState === 'following') setConfirmUnfollow(true);
                      else void toggleFollow();
                    }}
                  >
                    {updating
                      ? 'Updating…'
                      : profile.followState === 'following'
                        ? 'Following'
                        : profile.followState === 'pending'
                          ? 'Requested'
                          : 'Follow'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onMessage(profile.username)}
                  >
                    Message
                  </button>
                </>
              )}
            </div>
          </div>
          <ul className="profile-stats" aria-label="Profile counts">
            {!privatePreview && (
              <li>
                <strong>{cursor ? `${posts.length}+` : formatCount(posts.length)}</strong>{' '}
                {posts.length === 1 && !cursor ? 'post' : 'posts'}
              </li>
            )}
            {profile.followerCount !== null && (
              <li>
                <strong>{formatCount(profile.followerCount)}</strong>{' '}
                {profile.followerCount === 1 ? 'follower' : 'followers'}
              </li>
            )}
            {profile.followingCount !== null && (
              <li>
                <strong>{formatCount(profile.followingCount)}</strong> following
              </li>
            )}
          </ul>
          <div className="profile-bio">
            {profile.displayName && <strong>{profile.displayName}</strong>}
            {profile.bio && <p>{profile.bio}</p>}
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </header>

      {privatePreview ? (
        <div className="profile-private">
          <span className="empty-icon" aria-hidden="true">
            <Lock />
          </span>
          <h3>This account is private</h3>
          <p>Follow this account to see its posts.</p>
        </div>
      ) : (
        <>
          <div className="profile-tabs">
            <span className="profile-tab is-active">
              <Grid3x3 aria-hidden="true" /> Posts
            </span>
          </div>
          {posts.length === 0 ? (
            <div className="profile-empty">
              <span className="empty-icon" aria-hidden="true">
                <Camera />
              </span>
              <h3>{isOwnProfile ? 'Share photos' : 'No posts yet'}</h3>
              {isOwnProfile && <p>When you share photos, they will appear on your profile.</p>}
            </div>
          ) : (
            <div className="profile-grid" aria-label="Profile posts">
              {posts.map((post) => (
                <button
                  type="button"
                  className="grid-tile"
                  key={post.id}
                  onClick={() => setOpenPost(post)}
                >
                  <PostImage src={post.imageUrl} alt={post.caption} loading="lazy" />
                  <span className="grid-overlay" aria-hidden="true">
                    <Heart fill="currentColor" /> {formatCount(post.likeCount)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {moreError && (
            <p className="inline-error" role="alert">
              {moreError}
            </p>
          )}
          {cursor && (
            <div className="load-more-row" ref={sentinel}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadMorePosts()}
                disabled={loadingMore}
              >
                {loadingMore
                  ? 'Loading posts…'
                  : moreError
                    ? 'Retry loading posts'
                    : 'Load more posts'}
              </button>
            </div>
          )}
        </>
      )}

      {confirmUnfollow && (
        <ConfirmDialog
          avatar={<Avatar username={profile.username} src={profile.avatarUrl} size={90} />}
          title={`Unfollow @${profile.username}?`}
          body={
            profile.isPrivate
              ? `If you change your mind, you'll have to request to follow @${profile.username} again.`
              : undefined
          }
          confirmLabel="Unfollow"
          onCancel={() => setConfirmUnfollow(false)}
          onConfirm={() => void toggleFollow()}
        />
      )}
      {openPost && (
        <PostViewer
          post={openPost}
          currentUserId={viewer.id}
          onClose={() => setOpenPost(null)}
          onOpenProfile={onOpenProfile}
          onChange={(updated) =>
            setPosts((current) => current.map((item) => (item.id === updated.id ? updated : item)))
          }
        />
      )}
    </section>
  );
}

function ChangePhotoDialog({
  user,
  setUser,
  onClose,
}: {
  user: User;
  setUser: (user: User) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!acceptedImageTypes.includes(file.type)) {
      setError('Choose a valid JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('Images must be 8 MB or smaller.');
      return;
    }
    setBusy('upload');
    try {
      const body = new window.FormData();
      body.append('image', file, file.name);
      const response = await request<AuthResponse>('/users/me/avatar', { method: 'POST', body });
      setUser(response.data.user);
      toast('Profile photo updated.');
      onClose();
    } catch (uploadError) {
      setError(
        userErrorMessage(uploadError, 'Unable to update your profile photo. Please try again.'),
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setError('');
    setBusy('remove');
    try {
      const response = await request<AuthResponse>('/users/me/avatar', { method: 'DELETE' });
      setUser(response.data.user);
      toast('Profile photo removed.');
      onClose();
    } catch (removeError) {
      setError(
        userErrorMessage(removeError, 'Unable to remove your profile photo. Please try again.'),
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      labelledBy="change-photo-title"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="confirm-dialog change-photo"
      showClose={false}
    >
      <div className="confirm-body">
        <span className={`change-photo-avatar ${busy === 'upload' ? 'is-busy' : ''}`}>
          <Avatar username={user.username} src={user.avatarUrl} size={56} />
          {busy === 'upload' && <Spinner size={22} />}
        </span>
        <h2 id="change-photo-title">Change profile photo</h2>
      </div>
      {error && (
        <p className="inline-error change-photo-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="confirm-action is-primary"
        disabled={busy !== null}
        onClick={() => fileInput.current?.click()}
      >
        {busy === 'upload' ? 'Uploading…' : 'Upload photo'}
      </button>
      {user.avatarUrl && (
        <button
          type="button"
          className="confirm-action is-danger"
          disabled={busy !== null}
          onClick={() => void remove()}
        >
          {busy === 'remove' ? 'Removing…' : 'Remove current photo'}
        </button>
      )}
      <button type="button" className="confirm-action" disabled={busy !== null} onClick={onClose}>
        Cancel
      </button>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        accept={acceptedImageTypes.join(',')}
        aria-label="Profile photo"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          void upload(file);
        }}
      />
    </Modal>
  );
}

function EditProfile({
  user,
  setUser,
  onChanged,
  onChangePhoto,
}: {
  user: User;
  setUser: (user: User) => void;
  onChanged: () => void;
  onChangePhoto: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [bio, setBio] = useState(user.bio || '');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSaving(true);
    const form = new FormData(event.currentTarget);

    try {
      const response = await request<AuthResponse>('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: form.get('displayName'),
          bio: form.get('bio'),
          isPrivate: form.get('isPrivate') === 'on',
        }),
      });
      setUser(response.data.user);
      onChanged();
      toast('Profile saved.');
    } catch (saveError) {
      setError(
        userErrorMessage(saveError, 'The request could not be completed. Please try again.'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="edit-profile" aria-labelledby="edit-profile-heading">
      <h1 id="edit-profile-heading">Edit profile</h1>
      <div className="edit-card">
        <button
          type="button"
          className="edit-card-avatar"
          aria-label="Change profile photo"
          onClick={onChangePhoto}
        >
          <Avatar username={user.username} src={user.avatarUrl} size={56} />
        </button>
        <div className="person-text">
          <strong>{user.username}</strong>
          <span>{user.displayName}</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={onChangePhoto}>
          Change photo
        </button>
      </div>
      <form className="edit-form" onSubmit={save}>
        <label className="edit-field">
          <span>Name</span>
          <input name="displayName" defaultValue={user.displayName} maxLength={80} required />
        </label>
        <div className="edit-field">
          <label htmlFor="edit-bio">Bio</label>
          <textarea
            id="edit-bio"
            name="bio"
            value={bio}
            maxLength={150}
            onChange={(event) => setBio(event.currentTarget.value)}
          />
          <small className="edit-counter" aria-live="polite">
            {bio.length} / 150
          </small>
        </div>
        <label className="edit-toggle">
          <span>
            <strong>Private account</strong>
            <small>
              When your account is private, only people you approve can see your photos and
              followers.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            name="isPrivate"
            defaultChecked={user.isPrivate}
          />
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="edit-actions">
          <button className="btn btn-primary edit-submit" disabled={saving}>
            {saving ? 'Saving…' : 'Submit'}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

function conversationStatus(conversation: ConversationSummary) {
  if (conversation.unreadCount > 0) {
    return conversation.unreadCount === 1
      ? '1 new message'
      : `${conversation.unreadCount} new messages`;
  }
  if (conversation.requestStatus === 'pending') {
    return conversation.requestedByMe ? 'Request pending' : 'Message request';
  }
  if (conversation.requestStatus === 'declined') return 'Request declined';
  return conversation.displayName !== conversation.username ? conversation.displayName : 'Active';
}

function MessagesPage({
  currentUser,
  initialRecipient,
  onRecipientConsumed,
  onOpenProfile,
  onReadStateChange,
}: {
  currentUser: User;
  initialRecipient: string;
  onRecipientConsumed: () => void;
  onOpenProfile: (username: string) => void;
  onReadStateChange?: () => void;
}) {
  const currentUserId = currentUser.id;
  const [tab, setTab] = useState<'primary' | 'requests'>('primary');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [newMessageOpen, setNewMessageOpen] = useState(Boolean(initialRecipient));
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [inboxCursor, setInboxCursor] = useState<string | null>(null);
  const [inboxState, setInboxState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [messageState, setMessageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [inboxError, setInboxError] = useState('');
  const [messageError, setMessageError] = useState('');
  const [retryInbox, setRetryInbox] = useState(0);
  const [retryMessages, setRetryMessages] = useState(0);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [moreConversationsError, setMoreConversationsError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [targetUsername, setTargetUsername] = useState(initialRecipient);
  const [firstMessage, setFirstMessage] = useState('');
  const [draft, setDraft] = useState('');
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestAction, setRequestAction] = useState(false);
  const [actionError, setActionError] = useState('');
  const [startError, setStartError] = useState('');
  const threadBody = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialRecipient) onRecipientConsumed();
    // Consume the recipient handed over from a profile once.
  }, []);

  useEffect(() => {
    let active = true;
    setInboxState('loading');
    setInboxError('');
    setInboxCursor(null);
    setMoreConversationsError('');
    request<{ data: ConversationsResponse }>('/conversations?limit=30')
      .then((response) => {
        if (!active) return;
        setConversations(response.data.conversations);
        setInboxCursor(response.data.nextCursor);
        setInboxState('ready');
        setSelected((current) =>
          current
            ? response.data.conversations.find((conversation) => conversation.id === current.id) ??
              current
            : current,
        );
      })
      .catch((loadError) => {
        if (active) {
          setInboxError(userErrorMessage(loadError, 'Unable to load your inbox. Please try again.'));
          setInboxState('error');
        }
      });
    return () => {
      active = false;
    };
  }, [retryInbox]);

  async function loadMoreConversations() {
    if (!inboxCursor || loadingMoreConversations) return;
    setLoadingMoreConversations(true);
    setMoreConversationsError('');
    try {
      const params = new URLSearchParams({ limit: '30', cursor: inboxCursor });
      const response = await request<{ data: ConversationsResponse }>(
        `/conversations?${params}`,
      );
      setConversations((current) => [
        ...current,
        ...response.data.conversations.filter(
          (nextConversation) =>
            !current.some((conversation) => conversation.id === nextConversation.id),
        ),
      ]);
      setInboxCursor(response.data.nextCursor);
    } catch (loadError) {
      setMoreConversationsError(
        userErrorMessage(loadError, 'Unable to load more conversations. Please try again.'),
      );
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      setMessageCursor(null);
      setMessageState('idle');
      return;
    }
    let active = true;
    setMessageState('loading');
    setMessageError('');
    setMessages([]);
    setMessageCursor(null);
    request<{ data: DirectMessagesResponse }>(
      `/conversations/${selected.id}/messages?limit=30`,
    )
      .then(async (response) => {
        if (!active) return;
        setMessages(response.data.messages);
        setMessageCursor(response.data.nextCursor);
        setMessageState('ready');
        try {
          await request(`/conversations/${selected.id}/read`, { method: 'PUT' });
          onReadStateChange?.();
          if (active) {
            setConversations((current) =>
              current.map((conversation) =>
                conversation.id === selected.id
                  ? { ...conversation, unreadCount: 0 }
                  : conversation,
              ),
            );
          }
        } catch (readError) {
          if (active) {
            setActionError(
              userErrorMessage(readError, 'Unable to update the conversation read state.'),
            );
          }
        }
      })
      .catch((loadError) => {
        if (active) {
          setMessageError(
            userErrorMessage(loadError, 'Unable to load this conversation. Please try again.'),
          );
          setMessageState('error');
        }
      });
    return () => {
      active = false;
    };
    // The conversation reloads when its id changes or a retry is requested.
  }, [selected?.id, retryMessages]);

  // Pick up new conversations, message requests and request answers without a reload.
  usePolling(
    () => {
      void request<{ data: ConversationsResponse }>('/conversations?limit=30')
        .then((response) => {
          const fresh = response.data.conversations;
          const freshIds = new Set(fresh.map((conversation) => conversation.id));
          setConversations((current) => [
            ...fresh,
            ...current.filter((conversation) => !freshIds.has(conversation.id)),
          ]);
          setSelected((current) => {
            if (!current) return current;
            const updated = fresh.find((conversation) => conversation.id === current.id);
            return updated && updated.requestStatus !== current.requestStatus
              ? { ...current, requestStatus: updated.requestStatus }
              : current;
          });
        })
        .catch(() => {
          // Retried on the next tick.
        });
    },
    5000,
    inboxState === 'ready',
  );

  // Pull new messages into the open conversation.
  usePolling(
    () => {
      if (!selected) return;
      const conversationId = selected.id;
      void request<{ data: DirectMessagesResponse }>(
        `/conversations/${conversationId}/messages?limit=30`,
      )
        .then((response) => {
          if (selectedIdRef.current !== conversationId) return;
          const known = new Set(messagesRef.current.map((message) => message.id));
          const added = response.data.messages.filter((message) => !known.has(message.id));
          if (added.length === 0) return;
          setMessages((current) => {
            const currentIds = new Set(current.map((message) => message.id));
            return [...added.filter((message) => !currentIds.has(message.id)), ...current];
          });
          if (added.some((message) => message.senderId !== currentUserId)) {
            void request(`/conversations/${conversationId}/read`, { method: 'PUT' })
              .then(() => onReadStateChange?.())
              .catch(() => {
                // The next poll marks it read.
              });
          }
        })
        .catch(() => {
          // Retried on the next tick.
        });
    },
    3000,
    messageState === 'ready' && !sending,
  );

  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.id ?? null;
  const messagesRef = useRef<DirectMessage[]>([]);
  messagesRef.current = messages;
  const lastMessageId = messages[0]?.id;

  // Jump to the newest message when the thread opens or a new message arrives,
  // but not when older history is loaded above.
  useEffect(() => {
    const node = threadBody.current;
    if (node && !loadingOlder) node.scrollTop = node.scrollHeight;
  }, [lastMessageId, selected?.id, loadingOlder]);

  async function startConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) return;
    const username = targetUsername.trim().replace(/^@/, '').toLowerCase();
    const text = firstMessage.trim();
    if (!/^[a-zA-Z0-9._]{3,30}$/.test(username) || !text) {
      setStartError('Enter a valid username and a message.');
      return;
    }
    setStarting(true);
    setStartError('');
    const idempotencyKey = requestKey ?? window.crypto.randomUUID();
    setRequestKey(idempotencyKey);
    try {
      const opened = await request<{
        data: {
          conversation: {
            id: string;
            requestStatus: ConversationSummary['requestStatus'];
            requestedByMe: boolean;
            created: boolean;
          };
        };
      }>(`/conversations/${encodeURIComponent(username)}`, {
        method: 'POST',
        body: JSON.stringify({ text, idempotencyKey }),
      });
      const conversation = opened.data.conversation;
      if (!conversation.created && conversation.requestStatus === 'accepted') {
        await request(`/conversations/${conversation.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text, idempotencyKey }),
        });
      }
      const summary: ConversationSummary = {
        id: conversation.id,
        username,
        displayName: username,
        requestStatus: conversation.requestStatus,
        requestedByMe: conversation.requestedByMe,
        lastMessageAt: new Date().toISOString(),
        unreadCount: 0,
      };
      setSelected(summary);
      setNewMessageOpen(false);
      setTargetUsername('');
      setActionError('');
      if (conversation.created || conversation.requestStatus === 'accepted') {
        setFirstMessage('');
        setRequestKey(null);
      } else if (conversation.requestedByMe) {
        setActionError('Your message request is already pending; wait for the recipient to accept.');
      } else {
        setActionError('Accept the pending message request before sending a message.');
      }
      setRetryInbox((attempt) => attempt + 1);
    } catch (startFailure) {
      setStartError(
        userErrorMessage(startFailure, 'Unable to start this conversation. Please try again.'),
      );
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selected || sending || selected.requestStatus !== 'accepted') return;
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setActionError('');
    const idempotencyKey = requestKey ?? window.crypto.randomUUID();
    setRequestKey(idempotencyKey);
    try {
      await request(`/conversations/${selected.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text, idempotencyKey }),
      });
      setDraft('');
      setRequestKey(null);
      setRetryMessages((attempt) => attempt + 1);
      setRetryInbox((attempt) => attempt + 1);
    } catch (sendError) {
      setActionError(
        userErrorMessage(sendError, 'Unable to send this message. Please try again.'),
      );
    } finally {
      setSending(false);
    }
  }

  async function loadOlder() {
    if (!selected || !messageCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const params = new URLSearchParams({ limit: '30', cursor: messageCursor });
      const response = await request<{ data: DirectMessagesResponse }>(
        `/conversations/${selected.id}/messages?${params}`,
      );
      setMessages((current) => [...current, ...response.data.messages]);
      setMessageCursor(response.data.nextCursor);
    } catch (loadError) {
      setOlderError(
        userErrorMessage(loadError, 'Unable to load older messages. Please try again.'),
      );
    } finally {
      setLoadingOlder(false);
    }
  }

  async function updateRequest(action: 'accept' | 'decline') {
    if (!selected || requestAction) return;
    setRequestAction(true);
    setActionError('');
    try {
      const response = await request<{
        data: { requestStatus: ConversationSummary['requestStatus'] };
      }>(`/conversations/${selected.id}/${action}`, { method: 'PUT' });
      setSelected((current) =>
        current ? { ...current, requestStatus: response.data.requestStatus } : current,
      );
      setRetryInbox((attempt) => attempt + 1);
    } catch (requestError) {
      setActionError(
        userErrorMessage(requestError, 'Unable to update this message request. Please try again.'),
      );
    } finally {
      setRequestAction(false);
    }
  }

  const incomingRequests = conversations.filter(
    (conversation) => conversation.requestStatus === 'pending' && !conversation.requestedByMe,
  );
  const regularConversations = conversations.filter(
    (conversation) => conversation.requestStatus !== 'pending' || conversation.requestedByMe,
  );
  const visibleConversations = tab === 'requests' ? incomingRequests : regularConversations;
  const orderedMessages = [...messages].reverse();

  function selectConversation(conversation: ConversationSummary) {
    setActionError('');
    setDraft('');
    setRequestKey(null);
    setSelected(conversation);
  }

  return (
    <div className={`inbox ${selected ? 'has-thread' : ''}`}>
      <section className="inbox-list" aria-label="Direct messages">
        <header className="inbox-list-header">
          <h1>{currentUser.username}</h1>
          <button
            type="button"
            className="icon-btn"
            aria-label="New message"
            onClick={() => {
              setStartError('');
              setNewMessageOpen(true);
            }}
          >
            <SquarePen aria-hidden="true" />
          </button>
        </header>
        <div className="inbox-tabs" role="tablist" aria-label="Inbox folders">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'primary'}
            className={tab === 'primary' ? 'is-active' : ''}
            onClick={() => setTab('primary')}
          >
            Messages
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'requests'}
            className={tab === 'requests' ? 'is-active' : ''}
            onClick={() => setTab('requests')}
          >
            Requests
            {incomingRequests.length > 0 && (
              <>
                {' '}
                <span className="tab-count">({incomingRequests.length})</span>
              </>
            )}
          </button>
        </div>
        <div className="inbox-scroll">
          {inboxState === 'loading' && (
            <p role="status" className="drawer-hint">
              Loading inbox…
            </p>
          )}
          {inboxState === 'error' && (
            <div className="drawer-hint">
              <p role="alert">{inboxError}</p>
              <button
                type="button"
                className="link-button"
                onClick={() => setRetryInbox((attempt) => attempt + 1)}
              >
                Retry inbox
              </button>
            </div>
          )}
          {inboxState === 'ready' && tab === 'primary' && incomingRequests.length > 0 && (
            <button type="button" className="request-banner" onClick={() => setTab('requests')}>
              <span className="request-banner-icon" aria-hidden="true">
                <MessageCircle />
              </span>
              <span className="person-text">
                <strong>Message requests</strong>
                <span>
                  {incomingRequests.length === 1
                    ? '1 person wants to message you'
                    : `${incomingRequests.length} people want to message you`}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="row-chevron" />
            </button>
          )}
          {inboxState === 'ready' && visibleConversations.length === 0 && (
            <p className="drawer-hint">
              {tab === 'requests' ? 'No message requests.' : 'No conversations yet.'}
            </p>
          )}
          {inboxState === 'ready' && visibleConversations.length > 0 && (
            <ul className="conversation-list" aria-label="Conversations">
              {visibleConversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={`conversation-row ${conversation.unreadCount > 0 ? 'is-unread' : ''}`}
                    aria-current={selected?.id === conversation.id ? 'page' : undefined}
                    onClick={() => selectConversation(conversation)}
                  >
                    <Avatar username={conversation.username} src={conversation.avatarUrl} size={56} />
                    <span className="person-text">
                      <strong>{conversation.username}</strong>
                      <span>
                        {conversationStatus(conversation)} ·{' '}
                        <time dateTime={conversation.lastMessageAt}>
                          {timeAgo(conversation.lastMessageAt)}
                        </time>
                      </span>
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span className="unread-indicator" aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {inboxCursor && inboxState === 'ready' && (
            <div className="drawer-hint">
              {moreConversationsError && <p role="alert">{moreConversationsError}</p>}
              <button
                type="button"
                className="link-button"
                disabled={loadingMoreConversations}
                onClick={() => void loadMoreConversations()}
              >
                {loadingMoreConversations
                  ? 'Loading conversations…'
                  : moreConversationsError
                    ? 'Retry conversations'
                    : 'Load more conversations'}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="thread" aria-label={selected ? `Conversation with @${selected.username}` : 'Conversation'}>
        {!selected ? (
          <div className="thread-empty">
            <span className="thread-empty-icon" aria-hidden="true">
              <MessageCircle />
            </span>
            <h2>Your messages</h2>
            <p>Send private messages to a friend.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setStartError('');
                setNewMessageOpen(true);
              }}
            >
              Send message
            </button>
          </div>
        ) : (
          <>
            <header className="thread-header">
              <button
                type="button"
                className="icon-btn thread-back"
                aria-label="Back to inbox"
                onClick={() => setSelected(null)}
              >
                <ChevronLeft aria-hidden="true" />
              </button>
              <button
                type="button"
                className="thread-user"
                onClick={() => onOpenProfile(selected.username)}
              >
                <Avatar username={selected.username} src={selected.avatarUrl} size={44} />
                <span className="person-text">
                  <strong>{selected.displayName || selected.username}</strong>
                  <span>{selected.username}</span>
                </span>
              </button>
            </header>
            <div className="thread-body" ref={threadBody}>
              <div className="thread-intro">
                <Avatar username={selected.username} src={selected.avatarUrl} size={96} />
                <strong>{selected.displayName || selected.username}</strong>
                <span>{selected.username} · Rubaagram</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => onOpenProfile(selected.username)}
                >
                  View profile
                </button>
              </div>
              {messageState === 'loading' && (
                <p role="status" className="drawer-hint">
                  Loading messages…
                </p>
              )}
              {messageState === 'error' && (
                <div className="drawer-hint">
                  <p role="alert">{messageError}</p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setRetryMessages((attempt) => attempt + 1)}
                  >
                    Retry messages
                  </button>
                </div>
              )}
              {messageCursor && messageState === 'ready' && (
                <button
                  type="button"
                  className="link-button thread-older"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
                </button>
              )}
              {olderError && (
                <p className="inline-error" role="alert">
                  {olderError}
                </p>
              )}
              {messageState === 'ready' && messages.length === 0 && (
                <p className="drawer-hint">No messages yet.</p>
              )}
              {messageState === 'ready' && messages.length > 0 && (
                <ol className="message-list" aria-label="Messages">
                  {orderedMessages.map((message, index) => {
                    const previous = orderedMessages[index - 1];
                    const showTime =
                      !previous ||
                      new Date(message.createdAt).getTime() -
                        new Date(previous.createdAt).getTime() >
                        60 * 60 * 1000;
                    const own = message.senderId === currentUserId;
                    return (
                      <li key={message.id} className={own ? 'message is-own' : 'message'}>
                        {showTime && (
                          <time className="message-time" dateTime={message.createdAt}>
                            {new Date(message.createdAt).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </time>
                        )}
                        <div className="message-row">
                          {!own && (
                            <Avatar
                              username={message.senderUsername}
                              src={selected.avatarUrl}
                              size={28}
                            />
                          )}
                          <p className="bubble" title={fullDate(message.createdAt)}>
                            <span className="sr-only">{message.senderUsername}: </span>
                            {message.text}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
            {actionError && (
              <p className="inline-error thread-error" role="alert">
                {actionError}
              </p>
            )}
            {selected.requestStatus === 'pending' && !selected.requestedByMe && (
              <div className="thread-request">
                <p>
                  <strong>{selected.username}</strong> wants to send you a message. Accept to
                  reply and continue the conversation.
                </p>
                <div className="thread-request-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={requestAction}
                    onClick={() => void updateRequest('decline')}
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={requestAction}
                    onClick={() => void updateRequest('accept')}
                  >
                    {requestAction ? 'Updating…' : 'Accept'}
                  </button>
                </div>
              </div>
            )}
            {selected.requestStatus === 'pending' && selected.requestedByMe && (
              <p role="status" className="thread-note">
                Waiting for the recipient to accept your message request.
              </p>
            )}
            {selected.requestStatus === 'declined' && (
              <p role="status" className="thread-note">
                This message request was declined.
              </p>
            )}
            {selected.requestStatus === 'accepted' && (
              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  aria-label="Message"
                  placeholder="Message…"
                  rows={1}
                  value={draft}
                  maxLength={2000}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                    setRequestKey(null);
                  }}
                />
                {(draft.trim() || sending) && (
                  <button
                    type="submit"
                    className="text-button"
                    aria-label={sending ? 'Sending…' : 'Send'}
                    disabled={sending || !draft.trim()}
                  >
                    {sending ? <Spinner size={14} /> : 'Send'}
                  </button>
                )}
              </form>
            )}
          </>
        )}
      </section>

      {newMessageOpen && (
        <Modal
          labelledBy="new-message-title"
          onClose={() => setNewMessageOpen(false)}
          className="new-message"
          showClose={false}
        >
          <form className="new-message-form" onSubmit={startConversation}>
            <header className="modal-header">
              <span className="modal-header-spacer" />
              <h2 id="new-message-title">New message</h2>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close new message"
                onClick={() => setNewMessageOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <label className="new-message-to">
              <span>To:</span>
              <input
                aria-label="Recipient username"
                placeholder="Username"
                value={targetUsername}
                onChange={(event) => setTargetUsername(event.currentTarget.value)}
                maxLength={31}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
            <label className="new-message-body">
              <span className="sr-only">First message</span>
              <textarea
                placeholder="Write a message…"
                value={firstMessage}
                onChange={(event) => {
                  setFirstMessage(event.currentTarget.value);
                  setRequestKey(null);
                }}
                maxLength={2000}
              />
            </label>
            {startError && (
              <p className="inline-error" role="alert">
                {startError}
              </p>
            )}
            <div className="new-message-footer">
              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={starting || !targetUsername.trim() || !firstMessage.trim()}
              >
                {starting ? 'Opening…' : 'Chat'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
