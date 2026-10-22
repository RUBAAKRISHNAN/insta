import {
  Bell,
  Camera,
  Heart,
  House,
  LogOut,
  MessageCircle,
  MessagesSquare,
  Plus,
  Search,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
import './auth.css';

type User = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  isPrivate?: boolean;
};

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Rubaagram home">
      <span className="brand-mark" aria-hidden="true">
        r
      </span>
      <span>rubaagram</span>
    </a>
  );
}

function Avatar({
  username,
  src,
  className = '',
}: {
  username: string;
  src?: string | null;
  className?: string;
}) {
  return (
    <span className={`avatar ${className}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : username.slice(0, 1).toUpperCase()}
    </span>
  );
}

function IconButton({
  label,
  children,
  className = '',
  disabled,
  onClick,
  pressed,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

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

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>('loading');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [register, setRegister] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
  }, [restoreAttempt]);

  if (restoreState === 'loading') {
    return (
      <main className="auth">
        <Brand />
        <p role="status">Restoring session…</p>
      </main>
    );
  }

  if (restoreState === 'error') {
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="restore-error-title">
          <Brand />
          <h1 id="restore-error-title">Unable to restore your session</h1>
          <p role="alert">The service could not be reached. Please try again.</p>
          <button onClick={() => setRestoreAttempt((attempt) => attempt + 1)}>Retry</button>
        </section>
      </main>
    );
  }

  if (user) {
    return <Profile user={user} setUser={setUser} />;
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
      setUser(response.data.user);
    } catch (submitError) {
      setError(
        userErrorMessage(submitError, 'The request could not be completed. Please try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-card">
        <Brand />
        <p className="auth-kicker">A little more connection, every day.</p>
        <h1>{register ? 'Create account' : 'Welcome back'}</h1>
        <form onSubmit={submit}>
          {register && (
            <>
              <label>
                Username
                <input name="username" minLength={3} required />
              </label>
              <label>
                Display name
                <input name="displayName" required />
              </label>
            </>
          )}
          <label>
            Email
            <input type="email" name="email" required />
          </label>
          <label>
            Password
            <input type="password" name="password" minLength={register ? 12 : 1} required />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button disabled={submitting}>
            {submitting ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button
          className="link"
          disabled={submitting}
          onClick={() => {
            setError('');
            setRegister(!register);
          }}
        >
          {register ? 'Sign in instead' : 'Create an account'}
        </button>
      </section>
    </main>
  );
}

function Profile({ user, setUser }: { user: User; setUser: (user: User | null) => void }) {
  const [feedRefresh, setFeedRefresh] = useState(0);
  const [profileStats, setProfileStats] = useState<ProfileSummary | null>(null);
  const [profileStatsError, setProfileStatsError] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [followRequests, setFollowRequests] = useState<
    Array<{ id: string; username: string; displayName: string }>
  >([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState('');
  const [requestActionId, setRequestActionId] = useState('');
  const [edit, setEdit] = useState(false);
  const [creatingPost, setCreatingPost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');
  const [postError, setPostError] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [createdPost, setCreatedPost] = useState<PostResponse | null>(null);
  const previewUrl = useMemo(() => (image ? URL.createObjectURL(image) : null), [image]);

  useEffect(() => {
    let active = true;
    request<{ data: { user: ProfileSummary } }>(
      `/users?username=${encodeURIComponent(user.username)}`,
    )
      .then((response) => {
        if (active) {
          setProfileStats(response.data.user);
          setProfileStatsError('');
        }
      })
      .catch(() => {
        if (active) setProfileStatsError('Unable to load your follower counts.');
      });
    return () => {
      active = false;
    };
  }, [user.username, feedRefresh]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function createPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPostError('');
    setCreatedPost(null);
    setUploading(true);
    const form = event.currentTarget;
    try {
      const fields = new window.FormData(form);
      const caption = fields.get('caption');
      if (!image || typeof caption !== 'string' || !caption.trim()) {
        setPostError('Choose an image and add a caption before sharing.');
        setUploading(false);
        return;
      }
      const body = new window.FormData();
      body.append('image', image, image.name);
      body.append('caption', caption);
      const response = await request<{ data: { post: PostResponse } }>('/posts', {
        method: 'POST',
        body,
      });
      setCreatedPost(response.data.post);
      setFeedRefresh((current) => current + 1);
      setImage(null);
      form.reset();
    } catch (postFailure) {
      setPostError(
        userErrorMessage(postFailure, 'The post could not be published. Please try again.'),
      );
    } finally {
      setUploading(false);
    }
  }

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
          avatarUrl: form.get('avatarUrl') || null,
          isPrivate: form.get('isPrivate') === 'on',
        }),
      });
      setUser(response.data.user);
      setEdit(false);
      setFeedRefresh((current) => current + 1);
    } catch (saveError) {
      setError(
        userErrorMessage(saveError, 'The request could not be completed. Please try again.'),
      );
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    setError('');
    setLoggingOut(true);
    try {
      await request<void>('/auth/logout', { method: 'POST' });
      setUser(null);
    } catch (logoutError) {
      setError(userErrorMessage(logoutError, 'Unable to log out. Please try again.'));
    } finally {
      setLoggingOut(false);
    }
  }

  async function loadFollowRequests() {
    setRequestsLoading(true);
    setRequestsError('');
    try {
      const response = await request<{
        data: { requests: Array<{ id: string; username: string; displayName: string }> };
      }>('/users/me/follow-requests');
      setFollowRequests(response.data.requests);
    } catch (requestError) {
      setRequestsError(userErrorMessage(requestError, 'Unable to load follow requests.'));
    } finally {
      setRequestsLoading(false);
    }
  }

  async function handleFollowRequest(id: string, action: 'approve' | 'reject') {
    if (requestActionId) return;
    setRequestActionId(id);
    setRequestsError('');
    try {
      await request<void>(`/users/follow-requests/${id}${action === 'approve' ? '/approve' : ''}`, {
        method: action === 'approve' ? 'PUT' : 'DELETE',
      });
      await loadFollowRequests();
      setFeedRefresh((current) => current + 1);
    } catch (requestError) {
      setRequestsError(userErrorMessage(requestError, 'Unable to update this follow request.'));
    } finally {
      setRequestActionId('');
    }
  }

  return (
    <main className="authenticated-layout">
      <aside className="sidebar">
        <Brand />
        <nav className="primary-nav" aria-label="Main navigation">
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              setSelectedProfile('');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <House aria-hidden="true" />
            <span>Home</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => document.getElementById('discover-search')?.focus()}
          >
            <Search aria-hidden="true" />
            <span>Discover</span>
          </button>
          <button
            type="button"
            className={`nav-item ${notificationsOpen ? 'is-active' : ''}`}
            aria-expanded={notificationsOpen}
            onClick={() => setNotificationsOpen((open) => !open)}
          >
            <Bell aria-hidden="true" />
            <span>{notificationsOpen ? 'Hide notifications' : 'Notifications'}</span>
          </button>
          <button
            type="button"
            className={`nav-item ${messagesOpen ? 'is-active' : ''}`}
            aria-expanded={messagesOpen}
            onClick={() => setMessagesOpen((open) => !open)}
          >
            <MessagesSquare aria-hidden="true" />
            <span>{messagesOpen ? 'Hide messages' : 'Messages'}</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => setSelectedProfile(user.username)}
          >
            <UserRound aria-hidden="true" />
            <span>Profile</span>
          </button>
          <button
            type="button"
            className="nav-item nav-create"
            aria-expanded={creatingPost}
            onClick={() => {
              setPostError('');
              setCreatingPost((open) => !open);
            }}
          >
            <Plus aria-hidden="true" />
            <span>{creatingPost ? 'Cancel post' : 'Create post'}</span>
          </button>
          <button
            type="button"
            className={`nav-item ${requestsOpen ? 'is-active' : ''}`}
            aria-expanded={requestsOpen}
            onClick={() => {
              const open = !requestsOpen;
              setRequestsOpen(open);
              if (open) void loadFollowRequests();
            }}
          >
            <UserRound aria-hidden="true" />
            <span>{requestsOpen ? 'Hide follow requests' : 'Follow requests'}</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <Avatar username={user.username} src={user.avatarUrl} />
          <div className="sidebar-user">
            <strong>{user.username}</strong>
            <span>{user.displayName}</span>
          </div>
          <IconButton
            label={loggingOut ? 'Logging out' : 'Log out'}
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            <LogOut aria-hidden="true" />
          </IconButton>
        </div>
      </aside>
      <section className="feed-column" id="home">
        <header className="mobile-header">
          <Brand />
        </header>
        <HomeFeed
          userId={user.id}
          refreshKey={feedRefresh}
          onOpenProfile={setSelectedProfile}
        />
      </section>
      <aside className="right-rail">
        <section className="profile-card">
          <div className="account-card-heading">
            <Avatar username={user.username} src={user.avatarUrl} className="avatar-large" />
            <div>
              <h1>{edit ? 'Edit profile' : user.displayName}</h1>
              <p>@{user.username}</p>
            </div>
          </div>
        {edit ? (
          <form onSubmit={save}>
            <label>
              Display name
              <input name="displayName" defaultValue={user.displayName} required />
            </label>
            <label>
              Bio
              <textarea name="bio" defaultValue={user.bio || ''} />
            </label>
            <label>
              Avatar URL
              <input name="avatarUrl" defaultValue={user.avatarUrl || ''} />
            </label>
            <label>
              <input type="checkbox" name="isPrivate" defaultChecked={user.isPrivate} />
              Private account
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button type="button" className="button-secondary" onClick={() => setEdit(false)}>
                Cancel
              </button>
              <button disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        ) : (
          <>
            <p className="profile-bio">{user.bio || 'No biography yet.'}</p>
            <div className="profile-counts" aria-label="Profile counts">
              <span><strong>{profileStats?.followerCount ?? '—'}</strong> followers</span>
              <span><strong>{profileStats?.followingCount ?? '—'}</strong> following</span>
            </div>
            {profileStatsError && <p role="status">{profileStatsError}</p>}
            <button
              className="button-secondary"
              onClick={() => {
                setError('');
                setEdit(true);
              }}
            >
              Edit profile
            </button>
          </>
        )}
        </section>
        {!edit && <DiscoverySearch onOpenProfile={setSelectedProfile} />}
        {notificationsOpen && (
          <NotificationsPanel onOpenProfile={setSelectedProfile} />
        )}
        {messagesOpen && <MessagesPanel currentUserId={user.id} />}
        {requestsOpen && (
          <section className="follow-requests" aria-label="Pending follow requests">
            <h2>Follow requests</h2>
            {requestsLoading && <p role="status">Loading follow requests…</p>}
            {requestsError && <p role="alert">{requestsError}</p>}
            {!requestsLoading && !requestsError && followRequests.length === 0 && (
              <p>No pending follow requests.</p>
            )}
            {followRequests.map((followRequest) => (
              <div className="follow-request" key={followRequest.id}>
                <span>@{followRequest.username}</span>
                <button
                  type="button"
                  disabled={requestActionId !== ''}
                  onClick={() => void handleFollowRequest(followRequest.id, 'approve')}
                >
                  {requestActionId === followRequest.id ? 'Updating…' : 'Approve'}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={requestActionId !== ''}
                  onClick={() => void handleFollowRequest(followRequest.id, 'reject')}
                >
                  Reject
                </button>
              </div>
            ))}
          </section>
        )}
        {selectedProfile && !edit && (
          <ProfilePage
            username={selectedProfile}
            viewerUsername={user.username}
            onClose={() => setSelectedProfile('')}
            onEdit={() => {
              setSelectedProfile('');
              setEdit(true);
            }}
            onChanged={() => setFeedRefresh((current) => current + 1)}
          />
        )}
        {creatingPost && !edit && (
          <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !uploading) setCreatingPost(false);
          }}>
            <section className="create-post-dialog" role="dialog" aria-modal="true" aria-labelledby="create-post-title">
              <header>
                <div>
                  <p className="eyebrow">SHARE A MOMENT</p>
                  <h2 id="create-post-title">Create a post</h2>
                </div>
                <IconButton label="Close create post" disabled={uploading} onClick={() => setCreatingPost(false)}>
                  <X aria-hidden="true" />
                </IconButton>
              </header>
              <form className="create-post-form" noValidate onSubmit={createPost}>
                <label className="upload-dropzone">
                  <Camera aria-hidden="true" />
                  <strong>{image ? image.name : 'Choose a photo to share'}</strong>
                  <span>JPG, PNG or WebP · up to 8 MB</span>
                  <input
                    name="image"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    required
                    aria-label="Image"
                    onChange={(event) => setImage(event.currentTarget.files?.[0] ?? null)}
                  />
                </label>
                {previewUrl && (
                  <img className="post-preview" src={previewUrl} alt="Selected image preview" />
                )}
                <label>
                  Caption
                  <textarea name="caption" maxLength={2200} placeholder="Write a caption…" required />
                </label>
                {postError && (
                  <p className="form-error" role="alert">
                    {postError}
                  </p>
                )}
                <button disabled={uploading || !image}>
                  {uploading ? 'Uploading…' : 'Share post'}
                </button>
              </form>
            </section>
          </div>
        )}
        {createdPost && (
          <section className="created-post" aria-label="Published post">
            <p role="status">Post published.</p>
            <img
              src={`${api}${createdPost.imageUrl}`}
              alt="Your published post"
              crossOrigin="use-credentials"
            />
            <p>{createdPost.caption}</p>
          </section>
        )}
        {error && !edit && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </aside>
    </main>
  );
}

function notificationDescription(type: Notification['type']) {
  switch (type) {
    case 'like':
      return 'liked your post.';
    case 'comment':
      return 'commented on your post.';
    case 'follow':
      return 'followed you.';
    case 'follow_request':
      return 'requested to follow you.';
    case 'follow_approved':
      return 'approved your follow request.';
  }
}

function NotificationsPanel({
  onOpenProfile,
}: {
  onOpenProfile: (username: string) => void;
}) {
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

  return (
    <section className="notifications-panel" aria-label="Notifications">
      <h2>Notifications</h2>
      {state === 'loading' && <p role="status">Loading notifications…</p>}
      {state === 'error' && (
        <div>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setRetry((attempt) => attempt + 1)}>
            Retry notifications
          </button>
        </div>
      )}
      {state === 'ready' && notifications.length === 0 && (
        <p className="notifications-empty">You have no notifications yet.</p>
      )}
      {state === 'ready' && notifications.length > 0 && (
        <ul className="notification-list">
          {notifications.map((notification) => (
            <li
              className={notification.readAt ? 'notification-read' : 'notification-unread'}
              key={notification.id}
              aria-label={notification.readAt ? 'Read notification' : 'Unread notification'}
            >
              <div>
                <button
                  type="button"
                  className="profile-link"
                  onClick={() => onOpenProfile(notification.actorUsername)}
                >
                  @{notification.actorUsername}
                </button>{' '}
                {notificationDescription(notification.type)}
                <time dateTime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
                {notification.resourceUrl && (
                  <a
                    href={`${api}${notification.resourceUrl}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View post
                  </a>
                )}
              </div>
              {!notification.readAt && (
                <button
                  type="button"
                  disabled={markingId !== null}
                  onClick={() => void markRead(notification.id)}
                >
                  {markingId === notification.id ? 'Updating…' : 'Mark as read'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {moreError && state === 'ready' && <p role="alert">{moreError}</p>}
      {actionError && state === 'ready' && <p role="alert">{actionError}</p>}
      {cursor && state === 'ready' && (
        <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore
            ? 'Loading more…'
            : moreError
              ? 'Retry loading more'
              : 'Load more notifications'}
        </button>
      )}
    </section>
  );
}

function MessagesPanel({ currentUserId }: { currentUserId: string }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [newMessageOpen, setNewMessageOpen] = useState(false);
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
  const [targetUsername, setTargetUsername] = useState('');
  const [draft, setDraft] = useState('');
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestAction, setRequestAction] = useState(false);
  const [actionError, setActionError] = useState('');

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
  }, [selected?.id, retryMessages]);

  async function startConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) return;
    const username = targetUsername.trim().toLowerCase();
    const text = draft.trim();
    if (!/^[a-zA-Z0-9._]{3,30}$/.test(username) || !text) {
      setActionError('Enter a valid username and a message.');
      return;
    }
    setStarting(true);
    setActionError('');
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
      if (conversation.created || conversation.requestStatus === 'accepted') {
        setDraft('');
        setRequestKey(null);
      } else if (conversation.requestedByMe) {
        setActionError('Your message request is already pending; wait for the recipient to accept.');
      } else {
        setActionError('Accept the pending message request before sending a message.');
      }
      setRetryInbox((attempt) => attempt + 1);
    } catch (startError) {
      setActionError(
        userErrorMessage(startError, 'Unable to start this conversation. Please try again.'),
      );
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <section className="messages-panel" aria-label="Direct messages">
      <h2>Inbox</h2>
      {(newMessageOpen || !selected) && (
        <form className="message-start-form" onSubmit={startConversation}>
          <label>
            Message username
            <input
              value={targetUsername}
              onChange={(event) => setTargetUsername(event.currentTarget.value)}
              minLength={3}
              maxLength={30}
              autoComplete="off"
              required
            />
          </label>
          <label>
            First message or message to send
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setRequestKey(null);
              }}
              maxLength={2000}
              required
            />
          </label>
          <button type="submit" disabled={starting || !targetUsername.trim() || !draft.trim()}>
            {starting ? 'Opening…' : 'Open or start conversation'}
          </button>
        </form>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {inboxState === 'loading' && <p role="status">Loading inbox…</p>}
      {inboxState === 'error' && (
        <div>
          <p role="alert">{inboxError}</p>
          <button type="button" onClick={() => setRetryInbox((attempt) => attempt + 1)}>
            Retry inbox
          </button>
        </div>
      )}
      {inboxState === 'ready' && conversations.length === 0 && (
        <p className="messages-empty">No conversations yet.</p>
      )}
      {inboxState === 'ready' && conversations.length > 0 && (
        <>
          {incomingRequests.length > 0 && (
            <section className="message-request-list" aria-label="Message requests">
              <h3>Message requests</h3>
              {incomingRequests.map((conversation) => (
                <button
                  type="button"
                  className="conversation-item"
                  key={conversation.id}
                  onClick={() => setSelected(conversation)}
                >
                  @{conversation.username}
                  {conversation.unreadCount > 0 && (
                    <span>{conversation.unreadCount} unread</span>
                  )}
                </button>
              ))}
            </section>
          )}
          <ul className="conversation-list" aria-label="Conversations">
            {regularConversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  className="conversation-item"
                  aria-current={selected?.id === conversation.id ? 'page' : undefined}
                  onClick={() => setSelected(conversation)}
                >
                  <span>@{conversation.username}</span>
                  <small>
                    {conversation.requestStatus === 'pending'
                      ? 'Request pending'
                      : conversation.requestStatus === 'declined'
                        ? 'Request declined'
                        : `${conversation.unreadCount} unread`}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {inboxCursor && inboxState === 'ready' && (
        <>
          {moreConversationsError && <p role="alert">{moreConversationsError}</p>}
          <button
            type="button"
            disabled={loadingMoreConversations}
            onClick={() => void loadMoreConversations()}
          >
            {loadingMoreConversations
              ? 'Loading conversations…'
              : moreConversationsError
                ? 'Retry conversations'
                : 'Load more conversations'}
          </button>
        </>
      )}
      {selected && (
        <section className="conversation-view" aria-label={`Conversation with @${selected.username}`}>
          <header>
            <h3>@{selected.username}</h3>
            <button type="button" onClick={() => setNewMessageOpen((open) => !open)}>
              {newMessageOpen ? 'Close new message' : 'New message'}
            </button>
            <button type="button" onClick={() => setSelected(null)}>
              Close conversation
            </button>
          </header>
          {selected.requestStatus === 'pending' && !selected.requestedByMe && (
            <div className="message-request-actions">
              <p>This person sent you a message request. Accept it to continue the conversation.</p>
              <button type="button" disabled={requestAction} onClick={() => void updateRequest('accept')}>
                {requestAction ? 'Updating…' : 'Accept request'}
              </button>
              <button type="button" disabled={requestAction} onClick={() => void updateRequest('decline')}>
                Decline request
              </button>
            </div>
          )}
          {selected.requestStatus === 'pending' && selected.requestedByMe && (
            <p role="status">Waiting for the recipient to accept your message request.</p>
          )}
          {selected.requestStatus === 'declined' && (
            <p role="status">This message request was declined.</p>
          )}
          {messageState === 'loading' && <p role="status">Loading messages…</p>}
          {messageState === 'error' && (
            <div>
              <p role="alert">{messageError}</p>
              <button type="button" onClick={() => setRetryMessages((attempt) => attempt + 1)}>
                Retry messages
              </button>
            </div>
          )}
          {messageCursor && messageState === 'ready' && (
            <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
          )}
          {olderError && <p role="alert">{olderError}</p>}
          {messageState === 'ready' && messages.length === 0 && (
            <p className="messages-empty">No messages yet.</p>
          )}
          {messageState === 'ready' && messages.length > 0 && (
            <ol className="message-list" aria-label="Messages">
              {[...messages].reverse().map((message) => (
                <li
                  key={message.id}
                  className={message.senderId === currentUserId ? 'message-own' : ''}
                >
                  <strong>@{message.senderUsername}</strong>
                  <p>{message.text}</p>
                  <time dateTime={message.createdAt}>
                    {new Date(message.createdAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </li>
              ))}
            </ol>
          )}
          {selected.requestStatus === 'accepted' && !newMessageOpen && (
            <form className="message-compose-form" onSubmit={sendMessage}>
              <label htmlFor="message-draft">Message (up to 2,000 characters)</label>
              <textarea
                id="message-draft"
                value={draft}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setRequestKey(null);
                }}
                maxLength={2000}
                required
              />
              <button type="submit" disabled={sending || !draft.trim()}>
                {sending ? 'Sending…' : 'Send message'}
              </button>
            </form>
          )}
        </section>
      )}
    </section>
  );
}

function DiscoverySearch({ onOpenProfile }: { onOpenProfile: (username: string) => void }) {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [profiles, setProfiles] = useState<DiscoveredProfile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  async function search(nextQuery = query) {
    const normalized = nextQuery.trim();
    if (normalized.length < 2 || normalized.length > 30 || state === 'loading') return;
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
      setProfiles(response.data.users);
      setCursor(response.data.nextCursor);
      setState('ready');
    } catch (searchError) {
      setError(userErrorMessage(searchError, 'Unable to search profiles. Please try again.'));
      setState('error');
    }
  }

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
    <section className="discovery-panel" aria-labelledby="discovery-heading">
      <h2 id="discovery-heading">Discover people</h2>
      <form
        className="profile-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Search usernames
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            id="discover-search"
            minLength={2}
            maxLength={30}
            pattern="[a-zA-Z0-9._]+"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" disabled={state === 'loading' || query.trim().length < 2}>
          {state === 'loading' ? 'Searching…' : 'Search'}
        </button>
      </form>
      {state === 'loading' && <p role="status">Searching profiles…</p>}
      {state === 'error' && (
        <div>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void search(activeQuery)}>
            Retry search
          </button>
        </div>
      )}
      {state === 'ready' && profiles.length === 0 && (
        <p className="discovery-empty">No profiles found.</p>
      )}
      {state === 'ready' && profiles.length > 0 && (
        <>
          <ul className="discovery-results">
            {profiles.map((profile) => (
              <li key={profile.username}>
                <button
                  type="button"
                  className="profile-result"
                  onClick={() => onOpenProfile(profile.username)}
                >
                  {profile.avatarUrl && (
                    <img src={profile.avatarUrl} alt="" width={36} height={36} />
                  )}
                  <span>
                    <strong>@{profile.username}</strong>
                    {profile.displayName && <small>{profile.displayName}</small>}
                  </span>
                  {profile.isPrivate && <small>Private</small>}
                </button>
              </li>
            ))}
          </ul>
          {error && <p role="alert">{error}</p>}
          {cursor && (
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : error ? 'Retry loading profiles' : 'Load more profiles'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ProfilePage({
  username,
  viewerUsername,
  onClose,
  onEdit,
  onChanged,
}: {
  username: string;
  viewerUsername: string;
  onClose: () => void;
  onEdit: () => void;
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

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setProfile(null);
    setPosts([]);
    setCursor(null);

    request<{ data: { user: ProfileSummary } }>(
      `/users?username=${encodeURIComponent(username)}`,
    )
      .then(async (response) => {
        if (!active) return;
        const loadedProfile = response.data.user;
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
          setError(userErrorMessage(pageError, 'Unable to load this profile. Please try again.'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [username, viewerUsername, retry]);

  async function toggleFollow() {
    if (!profile || updating) return;
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

  const isOwnProfile = profile?.username === viewerUsername;
  const privatePreview =
    profile?.isPrivate && !isOwnProfile && profile.followState !== 'following';

  return (
    <section className="profile-page" aria-labelledby="profile-page-heading">
      <header className="profile-page-header">
        <div>
          <p className="eyebrow">PROFILE</p>
          <h2 id="profile-page-heading">@{username}</h2>
        </div>
        <button type="button" className="link" onClick={onClose}>
          Close profile
        </button>
      </header>
      {loading && <p role="status">Loading profile…</p>}
      {error && (
        <div>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setRetry((attempt) => attempt + 1)}>
            Retry profile
          </button>
        </div>
      )}
      {profile && !loading && (
        <>
          <div className="profile-page-summary">
            <Avatar username={profile.username} src={profile.avatarUrl} className="profile-avatar" />
            <div>
              {profile.displayName && <h3>{profile.displayName}</h3>}
              {profile.bio && <p>{profile.bio}</p>}
              {profile.isPrivate && <p className="privacy-label">Private account</p>}
            </div>
            <div className="profile-counts">
              {profile.followerCount !== null && (
                <span>{profile.followerCount} followers</span>
              )}
              {profile.followingCount !== null && (
                <span>{profile.followingCount} following</span>
              )}
            </div>
            {isOwnProfile ? (
              <button type="button" onClick={onEdit}>
                Edit profile
              </button>
            ) : (
              <button
                type="button"
                aria-label={
                  profile.followState === 'following'
                    ? `Unfollow @${profile.username}`
                    : profile.followState === 'pending'
                      ? `Cancel follow request to @${profile.username}`
                      : `Follow @${profile.username}`
                }
                disabled={updating}
                onClick={() => void toggleFollow()}
              >
                {updating
                  ? 'Updating…'
                  : profile.followState === 'following'
                    ? 'Following'
                    : profile.followState === 'pending'
                      ? 'Requested'
                      : 'Follow'}
              </button>
            )}
          </div>
          {privatePreview ? (
            <div className="profile-private-message">
              <h3>This account is private</h3>
              <p>Follow this account to see its posts.</p>
            </div>
          ) : posts.length === 0 ? (
            <div className="profile-posts-empty">
              <h3>No posts yet</h3>
            </div>
          ) : (
            <div className="profile-post-grid" aria-label="Profile posts">
              {posts.map((post) => (
                <article className="profile-post" key={post.id}>
                  <img
                    src={`${api}${post.imageUrl}`}
                    alt={`Post by @${post.authorUsername}`}
                    crossOrigin="use-credentials"
                  />
                  <p>{post.caption}</p>
                  <time dateTime={post.createdAt}>
                    {new Date(post.createdAt).toLocaleDateString()}
                  </time>
                </article>
              ))}
            </div>
          )}
          {moreError && <p role="alert">{moreError}</p>}
          {!privatePreview && cursor && (
            <button type="button" onClick={() => void loadMorePosts()} disabled={loadingMore}>
              {loadingMore ? 'Loading posts…' : moreError ? 'Retry loading posts' : 'Load more posts'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function HomeFeed({
  userId,
  refreshKey,
  onOpenProfile,
}: {
  userId: string;
  refreshKey: number;
  onOpenProfile: (username: string) => void;
}) {
  const [posts, setPosts] = useState<FeedPostWithLikes[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');

  useEffect(() => {
    let active = true;
    setState('loading');
    setPosts([]);
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

  return (
    <section className="feed-panel" aria-labelledby="feed-heading">
      <header className="feed-heading">
        <div>
          <p className="eyebrow">YOUR COMMUNITY</p>
          <h1 id="feed-heading">Home feed</h1>
        </div>
      </header>
      {state === 'loading' && <p role="status">Loading your feed…</p>}
      {state === 'error' && (
        <div className="feed-message">
          <p role="alert">Unable to load your feed. Please try again.</p>
          <button onClick={() => setRetry((attempt) => attempt + 1)}>Retry</button>
        </div>
      )}
      {state === 'ready' && posts.length === 0 && (
        <div className="feed-empty">
          <h2>Your feed is quiet</h2>
          <p>Posts from public profiles will appear here.</p>
        </div>
      )}
      {state === 'ready' && posts.length > 0 && (
        <>
          <div className="home-feed">
            {posts.map((post) => (
              <FeedPostCard
                key={post.id}
                post={post}
                currentUserId={userId}
                onOpenProfile={onOpenProfile}
              />
            ))}
          </div>
          {moreError && <p role="alert">{moreError}</p>}
          {nextCursor && (
            <button className="load-more" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading more…' : moreError ? 'Retry loading more' : 'Load more'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function FeedPostCard({
  post,
  currentUserId,
  onOpenProfile,
}: {
  post: FeedPostWithLikes;
  currentUserId: string;
  onOpenProfile: (username: string) => void;
}) {
  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [liking, setLiking] = useState(false);
  const [likeError, setLikeError] = useState('');
  const [commentsOpen, setCommentsOpen] = useState(false);
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
    } catch (error) {
      setLikeError(userErrorMessage(error, 'Unable to update your like. Please try again.'));
    } finally {
      setLiking(false);
    }
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

  async function toggleComments() {
    const open = !commentsOpen;
    setCommentsOpen(open);
    if (open && commentsState === 'idle') await loadComments();
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingComment) return;
    setCommentMutationError('');
    setSubmittingComment(true);
    const idempotencyKey = commentRequestKey ?? window.crypto.randomUUID();
    try {
      const response = await request<{ data: { comment: PostComment } }>(
        `/posts/${post.id}/comments`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ text: commentDraft }),
        },
      );
      setComments((current) => [response.data.comment, ...current]);
      setCommentDraft('');
      setCommentRequestKey(null);
      setCommentsOpen(true);
      setCommentsState('ready');
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
    } catch (error) {
      setCommentMutationError(
        userErrorMessage(error, 'Unable to delete your comment. Please try again.'),
      );
    } finally {
      setDeletingCommentId(null);
    }
  }

  return (
    <article className="feed-post">
      <header className="feed-post-header">
        <Avatar username={post.authorUsername} className="feed-avatar" />
        <div className="feed-post-meta">
          <button
            type="button"
            className="profile-link"
            onClick={() => onOpenProfile(post.authorUsername)}
          >
            @{post.authorUsername}
          </button>
          <time dateTime={post.createdAt}>
            {new Date(post.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </time>
        </div>
      </header>
      <img
        className="feed-post-image"
        src={`${api}${post.imageUrl}`}
        alt={`Post by @${post.authorUsername}`}
        crossOrigin="use-credentials"
      />
      <p className="feed-caption">
        <strong>@{post.authorUsername}</strong> {post.caption}
      </p>
      <div className="feed-post-actions">
        <button
          type="button"
          className={`post-action ${liked ? 'is-liked' : ''}`}
          aria-pressed={liked}
          disabled={liking}
          onClick={toggleLike}
        >
          <Heart aria-hidden="true" fill={liked ? 'currentColor' : 'none'} />
          {liking ? 'Updating like…' : liked ? 'Unlike' : 'Like'}
        </button>
        <span aria-live="polite">
          {likeCount} {likeCount === 1 ? 'like' : 'likes'}
        </span>
        <button
          type="button"
          className="post-action"
          aria-expanded={commentsOpen}
          aria-controls={`comments-${post.id}`}
          onClick={toggleComments}
        >
          <MessageCircle aria-hidden="true" />
          {commentsOpen ? 'Hide comments' : 'Comments'}
        </button>
      </div>
      {likeError && (
        <p className="interaction-error" role="alert">
          {likeError}
        </p>
      )}
      {commentsOpen && (
        <section className="comments-panel" id={`comments-${post.id}`} aria-label="Comments">
          {commentsState === 'loading' && <p role="status">Loading comments…</p>}
          {commentsState === 'error' && (
            <div>
              <p role="alert">{commentsError}</p>
              <button type="button" onClick={() => void loadComments()}>
                Retry comments
              </button>
            </div>
          )}
          {commentsState === 'ready' && comments.length === 0 && (
            <p className="comments-empty">No comments yet.</p>
          )}
          {commentsState === 'ready' && comments.length > 0 && (
            <ul className="comment-list">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <div>
                    <strong>@{comment.authorUsername}</strong>
                    <p>{comment.text}</p>
                    <time dateTime={comment.createdAt}>
                      {new Date(comment.createdAt).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </div>
                  {comment.authorId === currentUserId && (
                    <button
                      type="button"
                      aria-label={`Delete comment by @${comment.authorUsername}`}
                      disabled={deletingCommentId !== null}
                      onClick={() => void deleteComment(comment.id)}
                    >
                      {deletingCommentId === comment.id ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {commentsError && commentsState === 'ready' && <p role="alert">{commentsError}</p>}
          {commentsCursor && commentsState === 'ready' && (
            <button
              type="button"
              disabled={loadingMoreComments}
              onClick={() => void loadComments(commentsCursor)}
            >
              {loadingMoreComments ? 'Loading comments…' : 'More comments'}
            </button>
          )}
          {commentMutationError && <p role="alert">{commentMutationError}</p>}
          <form onSubmit={submitComment}>
            <label htmlFor={`comment-${post.id}`}>Add a comment</label>
            <textarea
              id={`comment-${post.id}`}
              value={commentDraft}
              maxLength={1000}
              required
              onChange={(event) => {
                setCommentDraft(event.currentTarget.value);
                setCommentRequestKey(null);
              }}
            />
            <button type="submit" disabled={submittingComment || !commentDraft.trim()}>
              {submittingComment ? 'Posting comment…' : 'Post comment'}
            </button>
          </form>
        </section>
      )}
    </article>
  );
}
