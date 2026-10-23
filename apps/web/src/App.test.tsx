import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const profile = {
  id: 'user-1',
  email: 'user@example.test',
  username: 'rubaagram_user',
  displayName: 'Rubaagram User',
  bio: 'Hello there',
  avatarUrl: null as string | null,
  isPrivate: false,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let feedFetchImplementation: typeof fetch | undefined;
let commentsFetchImplementation: typeof fetch | undefined;
let notificationBadgeImplementation: (() => Response) | undefined;
let inboxBadgeImplementation: (() => Response) | undefined;

/** Runs every active poll immediately, as returning to the tab does. */
function triggerPolls() {
  document.dispatchEvent(new Event('visibilitychange'));
}

function mockFetch(implementation: typeof fetch) {
  fetchMock.mockImplementation(implementation);
}

function unauthenticatedResponse() {
  return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required.');
}

function csrfResponse() {
  return jsonResponse({ data: { csrfToken: 'test-csrf-token' } });
}

function authenticatedResponse(user = profile) {
  return jsonResponse({ data: { user } });
}

function feedResponse(posts: unknown[] = [], nextCursor: string | null = null, status = 200) {
  return jsonResponse({ data: { posts, nextCursor } }, status);
}

const feedPost = {
  id: '33333333-3333-4333-8333-333333333333',
  caption: 'A sunny afternoon',
  createdAt: '2026-10-21T12:00:00.000000Z',
  authorId: '11111111-1111-4111-8111-111111111111',
  authorUsername: 'sunny_user',
  imageUrl: '/posts/33333333-3333-4333-8333-333333333333/image',
  likeCount: 0,
  likedByMe: false,
};

const comment = {
  id: '55555555-5555-4555-8555-555555555555',
  text: 'A great photo',
  createdAt: '2026-10-21T12:30:00.000000Z',
  authorId: '11111111-1111-4111-8111-111111111111',
  authorUsername: 'sunny_user',
};

async function openSignedOutApp(user = userEvent.setup()) {
  mockFetch(async (input) => {
    if (String(input).endsWith('/auth/me')) {
      return unauthenticatedResponse();
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Log in' });
  return user;
}

const ownProfileSummary = {
  username: profile.username,
  displayName: profile.displayName,
  bio: profile.bio,
  avatarUrl: null,
  isPrivate: false,
  followState: 'none',
  followerCount: 0,
  followingCount: 0,
};

/** Matches a profile stat such as "3 followers", whose number is rendered in its own element. */
function stat(text: string) {
  return (_content: string, element: Element | null) =>
    element?.tagName === 'LI' && element.textContent === text;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  fetchMock = vi.fn<typeof fetch>();
  feedFetchImplementation = undefined;
  commentsFetchImplementation = undefined;
  notificationBadgeImplementation = undefined;
  inboxBadgeImplementation = undefined;
  window.localStorage.clear();
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname.endsWith('/api/posts') && method === 'GET') {
      return feedFetchImplementation
        ? feedFetchImplementation(input, init)
        : Promise.resolve(feedResponse());
    }
    if (
      method === 'GET' &&
      url.pathname.endsWith('/api/users') &&
      url.searchParams.get('username') === profile.username
    ) {
      return Promise.resolve(jsonResponse({ data: { user: ownProfileSummary } }));
    }
    if (method === 'GET' && url.pathname.endsWith(`/api/users/${profile.username}/posts`)) {
      return Promise.resolve(feedResponse());
    }
    if (method === 'GET' && url.pathname.endsWith('/api/notifications/unread-count')) {
      return Promise.resolve(
        notificationBadgeImplementation?.() ??
          jsonResponse({ data: { count: 0, latestAt: null } }),
      );
    }
    if (method === 'GET' && url.pathname.endsWith('/api/conversations/unread-count')) {
      return Promise.resolve(
        inboxBadgeImplementation?.() ??
          jsonResponse({ data: { unreadConversations: 0, requests: 0 } }),
      );
    }
    if (
      url.pathname.includes('/comments') &&
      (init?.method ?? 'GET').toUpperCase() === 'GET' &&
      commentsFetchImplementation
    ) {
      return commentsFetchImplementation(input, init);
    }
    return fetchMock(input, init);
  }) as typeof fetch);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview-image'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('authentication and profile UI', () => {
  it('shows a loading state while restoring a session and then renders the profile', async () => {
    let finishRestore!: (response: Response) => void;
    mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          finishRestore = resolve;
        }),
    );

    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Restoring session');

    finishRestore(authenticatedResponse());

    expect(await screen.findByText('Rubaagram User')).toBeInTheDocument();
    expect(screen.getByText('rubaagram_user')).toBeInTheDocument();
  });

  it('shows the sign-in form for an unauthenticated session', async () => {
    await openSignedOutApp();

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('offers retry after session restoration fails and recovers when the API returns', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        errorResponse(503, 'INTERNAL_ERROR', 'Internal database connection string leaked'),
      )
      .mockResolvedValueOnce(authenticatedResponse());

    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Unable to restore your session' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The service could not be reached');
    expect(screen.queryByText(/connection string/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Rubaagram User')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/auth/me')),
    ).toHaveLength(2);
  });

  it('registers an account with the API and displays the new profile', async () => {
    const user = await openSignedOutApp();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/register')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${url}`);
    });

    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    await user.type(screen.getByLabelText('Username'), profile.username);
    await user.type(screen.getByLabelText('Full name'), profile.displayName);
    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'Secure-password-123!');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByText('Rubaagram User')).toBeInTheDocument();
    const registrationCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/auth/register'),
    );
    expect(registrationCall).toBeDefined();
    expect(JSON.parse(String(registrationCall?.[1]?.body))).toMatchObject({
      username: profile.username,
      displayName: profile.displayName,
      email: profile.email,
    });
    expect(new Headers(registrationCall?.[1]?.headers).get('x-csrf-token')).toBe('test-csrf-token');
    expect(registrationCall?.[1]?.credentials).toBe('include');
  });

  it('shows a safe registration error from the API', async () => {
    const user = await openSignedOutApp();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/register')) {
        return errorResponse(409, 'ACCOUNT_EXISTS', 'Private server detail: existing account');
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    await user.type(screen.getByLabelText('Username'), profile.username);
    await user.type(screen.getByLabelText('Full name'), profile.displayName);
    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'Secure-password-123!');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with those details already exists.',
    );
    expect(screen.queryByText(/private server detail/i)).not.toBeInTheDocument();
  });

  it('logs in and displays the authenticated profile', async () => {
    const user = await openSignedOutApp();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/login')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${url}`);
    });

    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'Secure-password-123!');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Rubaagram User')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/login'))).toBe(
      true,
    );
  });

  it('shows a disabled loading state while login is pending', async () => {
    const user = await openSignedOutApp();
    let finishLogin!: (response: Response) => void;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/login')) {
        return new Promise<Response>((resolve) => {
          finishLogin = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'Secure-password-123!');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(screen.getByRole('button', { name: 'Please wait…' })).toBeDisabled();
    finishLogin(authenticatedResponse());

    expect(await screen.findByText('Rubaagram User')).toBeInTheDocument();
  });

  it('shows a safe login error when the API rejects credentials', async () => {
    const user = await openSignedOutApp();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/login')) {
        return errorResponse(401, 'INVALID_CREDENTIALS', 'Sensitive authentication diagnostic');
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.queryByText(/sensitive authentication diagnostic/i)).not.toBeInTheDocument();
  });

  it('edits and saves the current profile', async () => {
    const user = await userEvent.setup();
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/users/me') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { displayName: string; bio: string };
        return authenticatedResponse({ ...profile, ...body });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Profile' }));
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    expect(window.location.pathname).toBe('/accounts/edit');
    const displayName = screen.getByLabelText('Name');
    await user.clear(displayName);
    await user.type(displayName, 'Updated Rubaagram');
    const bio = screen.getByLabelText('Bio');
    await user.clear(bio);
    await user.type(bio, 'Updated biography');
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(screen.getByText('Updated Rubaagram')).toBeInTheDocument();
    expect(screen.getByLabelText('Bio')).toHaveValue('Updated biography');
  });

  it('uploads and removes a profile photo', async () => {
    const user = userEvent.setup();
    const avatarPath = '/users/avatars/88888888-8888-4888-8888-888888888888.png';
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/users/me/avatar') && init?.method === 'POST') {
        return authenticatedResponse({ ...profile, avatarUrl: avatarPath });
      }
      if (url.endsWith('/users/me/avatar') && init?.method === 'DELETE') {
        return authenticatedResponse({ ...profile, avatarUrl: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Profile' }));
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    expect(screen.queryByLabelText('Avatar URL')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change photo' }));
    const dialog = screen.getByRole('dialog', { name: 'Change profile photo' });
    expect(within(dialog).queryByRole('button', { name: 'Remove current photo' })).toBeNull();
    await user.upload(
      within(dialog).getByLabelText('Profile photo'),
      new window.File(['image bytes'], 'me.png', { type: 'image/png' }),
    );

    expect(await screen.findByText('Profile photo updated.')).toBeInTheDocument();
    const upload = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith('/users/me/avatar') && init?.method === 'POST',
    );
    expect((upload?.[1]?.body as FormData).get('image')).toMatchObject({ name: 'me.png' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('.edit-card img')).toHaveAttribute(
      'src',
      `http://localhost:4000/api${avatarPath}`,
    );

    await user.click(screen.getByRole('button', { name: 'Change photo' }));
    await user.click(screen.getByRole('button', { name: 'Remove current photo' }));
    expect(await screen.findByText('Profile photo removed.')).toBeInTheDocument();
    expect(container.querySelector('.edit-card img')).toBeNull();
  });

  it('shows a safe profile update error and keeps the edit form open', async () => {
    const user = userEvent.setup();
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/users/me') && init?.method === 'PATCH') {
        return errorResponse(500, 'INTERNAL_ERROR', 'Internal stack trace');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Profile' }));
    await user.click(await screen.findByRole('button', { name: 'Edit profile' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable. Please try again later.',
    );
    expect(screen.getByRole('heading', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.queryByText(/internal stack trace/i)).not.toBeInTheDocument();
  });

  it('logs out after API confirmation', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows logout failures and keeps the authenticated profile visible', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/auth/logout')) {
        return errorResponse(503, 'INTERNAL_ERROR', 'Internal session store details');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable. Please try again later.',
    );
    expect(screen.getByText('Rubaagram User')).toBeInTheDocument();
    expect(screen.queryByText(/internal session store details/i)).not.toBeInTheDocument();
  });

  it('reports network errors without showing internal error text', async () => {
    const user = await openSignedOutApp();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith('/csrf')) return csrfResponse();
      throw new Error('Sensitive network diagnostic');
    });

    await user.type(screen.getByLabelText('Email'), profile.email);
    await user.type(screen.getByLabelText('Password'), 'Secure-password-123!');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to reach the service. Check your connection and try again.',
    );
    expect(screen.queryByText(/sensitive network diagnostic/i)).not.toBeInTheDocument();
  });

  it('previews a selected image, submits multipart data, and shows upload loading and success', async () => {
    const user = userEvent.setup();
    let finishUpload!: (response: Response) => void;
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/posts')) {
        return new Promise<Response>((resolve) => {
          finishUpload = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create' }));
    const file = new window.File(['image bytes'], 'sunset.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Image'), file);
    expect(screen.getByRole('img', { name: 'Selected image preview' })).toHaveAttribute(
      'src',
      'blob:preview-image',
    );
    await user.type(screen.getByLabelText('Caption'), 'A warm evening');
    expect(screen.getByLabelText('Caption')).toHaveValue('A warm evening');
    expect(screen.getByLabelText('Caption')).toBeValid();
    await user.click(screen.getByRole('button', { name: 'Share post' }));

    expect(screen.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    const uploadCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/posts'));
    expect(uploadCall?.[1]?.body).toBeInstanceOf(window.FormData);
    const formData = uploadCall?.[1]?.body as FormData;
    expect(formData.get('caption')).toBe('A warm evening');
    expect(formData.get('image')).toMatchObject({ name: 'sunset.png' });
    expect(new Headers(uploadCall?.[1]?.headers).has('content-type')).toBe(false);

    finishUpload(
      jsonResponse(
        {
          data: {
            post: {
              id: 'post-1',
              caption: 'A warm evening',
              imageUrl: '/posts/post-1/image',
              createdAt: '2026-10-21T00:00:00.000Z',
            },
          },
        },
        201,
      ),
    );
    expect(await screen.findByText('Your post has been shared.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Your published post' })).toHaveAttribute(
      'src',
      'http://localhost:4000/api/posts/post-1/image',
    );
  });

  it('shows safe upload errors and keeps the selected image available for retry', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/posts')) {
        return errorResponse(415, 'INVALID_UPLOAD', 'Internal file-system path');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Create' }));
    await user.upload(
      screen.getByLabelText('Image'),
      new window.File(['image bytes'], 'photo.png', { type: 'image/png' }),
    );
    await user.type(screen.getByLabelText('Caption'), 'Please keep this draft');
    expect(screen.getByLabelText('Caption')).toBeValid();
    await user.click(screen.getByRole('button', { name: 'Share post' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a valid JPEG, PNG, or WebP image.',
    );
    expect(screen.getByRole('img', { name: 'Selected image preview' })).toBeInTheDocument();
    expect(screen.queryByText(/internal file-system path/i)).not.toBeInTheDocument();
  });

  it('shows a loading state and renders feed posts with authorized image URLs', async () => {
    let finishFeed!: (response: Response) => void;
    mockFetch(async (input) => {
      if (String(input).endsWith('/auth/me')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    feedFetchImplementation = () =>
      new Promise<Response>((resolve) => {
        finishFeed = resolve;
      });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Home feed' })).toBeInTheDocument();
    expect(screen.getByText('Loading your feed…')).toBeInTheDocument();

    await waitFor(() => expect(finishFeed).toBeTypeOf('function'));
    finishFeed(feedResponse([feedPost]));
    expect(await screen.findByText('A sunny afternoon')).toBeInTheDocument();
    expect(screen.getAllByText('sunny_user')).toHaveLength(2);
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', feedPost.createdAt);
    expect(screen.getByRole('img', { name: 'Post by @sunny_user' })).toHaveAttribute(
      'src',
      `http://localhost:4000/api${feedPost.imageUrl}`,
    );
    expect(screen.getByRole('img', { name: 'Post by @sunny_user' })).toHaveAttribute(
      'crossOrigin',
      'use-credentials',
    );
  });

  it('shows an empty feed when the API returns no posts', async () => {
    mockFetch(async (input) => {
      if (String(input).endsWith('/auth/me')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Your feed is quiet' })).toBeInTheDocument();
    expect(screen.getByText('Posts from public profiles will appear here.')).toBeInTheDocument();
  });

  it('shows a safe feed error and retries successfully', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      if (String(input).endsWith('/auth/me')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const feedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(503, 'INTERNAL_ERROR', 'Sensitive database detail'))
      .mockResolvedValueOnce(feedResponse([feedPost]));
    feedFetchImplementation = feedFetch;
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load your feed. Please try again.',
    );
    expect(screen.queryByText(/sensitive database detail/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('A sunny afternoon')).toBeInTheDocument();
    expect(feedFetch).toHaveBeenCalledTimes(2);
  });

  it('loads more posts using the returned cursor and shows pagination loading', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      if (String(input).endsWith('/auth/me')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    let finishNextPage!: (response: Response) => void;
    const feedFetch = vi.fn<typeof fetch>((input) => {
      if (new URL(String(input)).searchParams.has('cursor')) {
        return new Promise<Response>((resolve) => {
          finishNextPage = resolve;
        });
      }
      return Promise.resolve(feedResponse([feedPost], 'next-page-cursor'));
    });
    feedFetchImplementation = feedFetch;
    render(<App />);

    expect(await screen.findByText('A sunny afternoon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('button', { name: 'Loading more…' })).toBeDisabled();
    expect(new URL(String(feedFetch.mock.calls[1][0])).searchParams.get('cursor')).toBe(
      'next-page-cursor',
    );

    const nextPost = {
      ...feedPost,
      id: '44444444-4444-4444-8444-444444444444',
      caption: 'The next page',
    };
    finishNextPage(feedResponse([nextPost]));
    expect(await screen.findByText('The next page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('likes and unlikes a feed post and displays the returned count', async () => {
    const user = userEvent.setup();
    let currentlyLiked = false;
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith(`/posts/${feedPost.id}/like`)) {
        currentlyLiked = !currentlyLiked;
        return jsonResponse({
          data: { liked: currentlyLiked, likeCount: currentlyLiked ? 1 : 0 },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    feedFetchImplementation = () => Promise.resolve(feedResponse([feedPost]));
    render(<App />);

    await screen.findByText('A sunny afternoon');
    const likeButton = screen.getByRole('button', { name: 'Like' });
    expect(likeButton).toHaveAttribute('aria-pressed', 'false');
    await user.click(likeButton);
    expect(await screen.findByText('1 like')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlike' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Unlike' }));
    expect(await screen.findByText('0 likes')).toBeInTheDocument();
    const mutations = fetchMock.mock.calls.filter(([called]) =>
      String(called).endsWith(`/posts/${feedPost.id}/like`),
    );
    expect(mutations.map(([, init]) => init?.method)).toEqual(['PUT', 'DELETE']);
    expect(mutations.every(([, init]) => new Headers(init?.headers).has('x-csrf-token'))).toBe(
      true,
    );
  });

  it('shows a safe like error while keeping the current state', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith(`/posts/${feedPost.id}/like`)) {
        return errorResponse(500, 'INTERNAL_ERROR', 'Database transaction detail');
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    feedFetchImplementation = () => Promise.resolve(feedResponse([feedPost]));
    render(<App />);

    await screen.findByText('A sunny afternoon');
    await user.click(screen.getByRole('button', { name: 'Like' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable. Please try again later.',
    );
    expect(screen.getByRole('button', { name: 'Like' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/database transaction detail/i)).not.toBeInTheDocument();
  });

  it('loads, creates, and deletes only the current user’s comments', async () => {
    const user = userEvent.setup();
    const ownComment = { ...comment, authorId: profile.id };
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith(`/posts/${feedPost.id}/comments`) && init?.method === 'POST') {
        return jsonResponse({ data: { comment: { ...ownComment, text: 'My new comment' } } }, 201);
      }
      if (
        url.endsWith(`/posts/${feedPost.id}/comments/${comment.id}`) &&
        init?.method === 'DELETE'
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    feedFetchImplementation = () =>
      Promise.resolve(feedResponse([{ ...feedPost, authorId: profile.id }]));
    commentsFetchImplementation = () =>
      Promise.resolve(jsonResponse({ data: { comments: [], nextCursor: null } }));
    render(<App />);

    await screen.findByText('A sunny afternoon');
    await user.click(screen.getByRole('button', { name: 'View comments' }));
    const viewer = await screen.findByRole('dialog', { name: 'Post by sunny_user' });
    expect(await within(viewer).findByText('No comments yet.')).toBeInTheDocument();
    await user.type(within(viewer).getByLabelText('Add a comment'), 'My new comment');
    await user.click(within(viewer).getByRole('button', { name: 'Post comment' }));
    expect(await within(viewer).findByText('My new comment')).toBeInTheDocument();
    const commentRequest = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith(`/posts/${feedPost.id}/comments`) && init?.method === 'POST',
    );
    expect(new Headers(commentRequest?.[1]?.headers).get('Idempotency-Key')).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(
      within(viewer).getByRole('button', { name: 'Delete comment by @sunny_user' }),
    ).toBeInTheDocument();
    await user.click(
      within(viewer).getByRole('button', { name: 'Delete comment by @sunny_user' }),
    );
    expect(within(viewer).queryByText('My new comment')).not.toBeInTheDocument();
  });

  it('shows comment loading, API failure, and retry states', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      throw new Error(`Unexpected request: ${url}`);
    });
    let finishComments!: (response: Response) => void;
    const commentsFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishComments = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { comments: [comment], nextCursor: null } }));
    feedFetchImplementation = () => Promise.resolve(feedResponse([feedPost]));
    commentsFetchImplementation = commentsFetch;
    render(<App />);

    await screen.findByText('A sunny afternoon');
    await user.click(screen.getByRole('button', { name: 'View comments' }));
    expect(
      within(screen.getByRole('region', { name: 'Comments' })).getByRole('status'),
    ).toHaveTextContent('Loading comments');
    finishComments(errorResponse(503, 'INTERNAL_ERROR', 'Comment query details'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable. Please try again later.',
    );
    expect(screen.queryByText(/comment query details/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry comments' }));
    expect(await screen.findByText('A great photo')).toBeInTheDocument();
    expect(commentsFetch).toHaveBeenCalledTimes(2);
  });

  it('disables comment submission while a request is pending', async () => {
    const user = userEvent.setup();
    let finishComment!: (response: Response) => void;
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith(`/posts/${feedPost.id}/comments`) && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          finishComment = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    feedFetchImplementation = () => Promise.resolve(feedResponse([feedPost]));
    commentsFetchImplementation = () =>
      Promise.resolve(jsonResponse({ data: { comments: [], nextCursor: null } }));
    render(<App />);

    await screen.findByText('A sunny afternoon');
    await user.click(screen.getByRole('button', { name: 'View comments' }));
    const viewer = await screen.findByRole('dialog', { name: 'Post by sunny_user' });
    await within(viewer).findByText('No comments yet.');
    await user.type(within(viewer).getByLabelText('Add a comment'), 'Only once');
    await user.click(within(viewer).getByRole('button', { name: 'Post comment' }));
    expect(within(viewer).getByRole('button', { name: 'Posting comment…' })).toBeDisabled();
    await user.click(within(viewer).getByRole('button', { name: 'Posting comment…' }));
    const commentRequests = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith(`/posts/${feedPost.id}/comments`) && init?.method === 'POST',
    );
    expect(commentRequests).toHaveLength(1);

    finishComment(jsonResponse({ data: { comment: { ...comment, text: 'Only once' } } }, 201));
    expect(await screen.findByText('Only once')).toBeInTheDocument();
  });

  it('shows author photos and lists comments written from the feed under the caption', async () => {
    const user = userEvent.setup();
    const avatarPath = '/users/avatars/99999999-9999-4999-8999-999999999999.png';
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith(`/posts/${feedPost.id}/comments`) && init?.method === 'POST') {
        return jsonResponse(
          {
            data: {
              comment: {
                ...comment,
                authorId: profile.id,
                authorUsername: profile.username,
                text: 'Lovely light 😍',
              },
            },
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    feedFetchImplementation = () =>
      Promise.resolve(feedResponse([{ ...feedPost, authorAvatarUrl: avatarPath }]));
    const { container } = render(<App />);

    await screen.findByText('A sunny afternoon');
    expect(container.querySelector('.post-header img')).toHaveAttribute(
      'src',
      `http://localhost:4000/api${avatarPath}`,
    );
    await user.type(screen.getByLabelText('Add a comment'), 'Lovely light ');
    await user.click(screen.getByRole('button', { name: 'Emoji' }));
    await user.click(screen.getByRole('button', { name: 'Insert 😍' }));
    expect(screen.getByLabelText('Add a comment')).toHaveValue('Lovely light 😍');
    await user.click(screen.getByRole('button', { name: 'Post comment' }));

    expect(await screen.findByText('Lovely light 😍')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Add a comment')).toHaveValue('');
  });

  it('shows a private profile request state and lets the viewer cancel it', async () => {
    const user = userEvent.setup();
    let requested = false;
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users/discover')) {
        return jsonResponse({
          data: {
            users: [{ username: 'private_user', isPrivate: true, followState: requested ? 'pending' : 'none' }],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith('/users') && init?.method !== 'PUT') {
        const username = url.searchParams.get('username');
        return jsonResponse({
          data: {
            user:
              username === profile.username
                ? {
                    username: profile.username,
                    displayName: profile.displayName,
                    bio: profile.bio,
                    avatarUrl: null,
                    isPrivate: false,
                    followState: 'none',
                    followerCount: 0,
                    followingCount: 0,
                  }
                : {
                    username: 'private_user',
                    isPrivate: true,
                    followState: requested ? 'pending' : 'none',
                    followerCount: null,
                    followingCount: null,
                  },
          },
        });
      }
      if (url.pathname.endsWith('/users/private_user/follow')) {
        requested = init?.method === 'PUT';
        return jsonResponse({ data: { followState: requested ? 'pending' : 'none' } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'private_user');
    await user.click(await screen.findByRole('button', { name: /private_user/ }));
    expect(await screen.findByText('This account is private')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'private_user' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/private_user');
    expect(
      within(screen.getByRole('region', { name: 'private_user' })).queryByText(stat('0 followers')),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Follow @private_user' }));
    expect(
      await screen.findByRole('button', { name: 'Cancel follow request to @private_user' }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Cancel follow request to @private_user' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Follow @private_user' }),
    ).toBeInTheDocument();
    const followMutations = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/users/private_user/follow'),
    );
    expect(followMutations.map(([, init]) => init?.method)).toEqual(['PUT', 'DELETE']);
  });

  it('loads and approves pending follow requests', async () => {
    const user = userEvent.setup();
    let requests = [
      { id: 'requester-1', username: 'waiting_user', displayName: 'Waiting User' },
      { id: 'requester-2', username: 'declined_user', displayName: 'Declined User' },
    ];
    mockFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.endsWith('/csrf')) return csrfResponse();
      if (url.endsWith('/users/me/follow-requests') && init?.method !== 'PUT') {
        return jsonResponse({ data: { requests } });
      }
      if (url.includes('/notifications?')) {
        return jsonResponse({ data: { notifications: [], nextCursor: null } });
      }
      if (url.endsWith('/users/follow-requests/requester-1/approve')) {
        requests = requests.filter((item) => item.id !== 'requester-1');
        return jsonResponse({ data: { status: 'accepted' } });
      }
      if (url.endsWith('/users/follow-requests/requester-2')) {
        requests = requests.filter((item) => item.id !== 'requester-2');
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/users?username=rubaagram_user')) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    await user.click(screen.getByRole('button', { name: 'Follow requests' }));
    expect(await screen.findByText('waiting_user')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('region', { name: 'Pending follow requests' })).getAllByRole(
        'button',
        { name: 'Confirm' },
      )[0],
    );
    expect(await screen.findByText('declined_user')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('waiting_user')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No pending follow requests.')).toBeInTheDocument();
    const approval = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/users/follow-requests/requester-1/approve'),
    );
    expect(approval?.[1]?.method).toBe('PUT');
    expect(new Headers(approval?.[1]?.headers).has('x-csrf-token')).toBe(true);
    const rejection = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/users/follow-requests/requester-2'),
    );
    expect(rejection?.[1]?.method).toBe('DELETE');
  });

  it('shows Following after an accepted follow and refreshes the profile count on unfollow', async () => {
    const user = userEvent.setup();
    let following = false;
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users/discover')) {
        return jsonResponse({
          data: {
            users: [
              {
                username: 'public_user',
                displayName: 'Public User',
                isPrivate: false,
                followState: following ? 'following' : 'none',
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith('/users') && url.searchParams.has('username')) {
        const username = url.searchParams.get('username');
        return jsonResponse({
          data: {
            user:
              username === profile.username
                ? {
                    username: profile.username,
                    displayName: profile.displayName,
                    bio: profile.bio,
                    avatarUrl: null,
                    isPrivate: false,
                    followState: 'none',
                    followerCount: 0,
                    followingCount: 0,
                  }
                : {
                    username: 'public_user',
                    displayName: 'Public User',
                    isPrivate: false,
                    followState: following ? 'following' : 'none',
                    followerCount: following ? 4 : 3,
                    followingCount: 1,
                  },
          },
        });
      }
      if (url.pathname.endsWith('/users/public_user/follow')) {
        following = init?.method === 'PUT';
        return jsonResponse({ data: { followState: following ? 'following' : 'none' } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'public_user');
    await user.click(await screen.findByRole('button', { name: /public_user/ }));
    expect(await screen.findByText(stat('3 followers'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Follow @public_user' }));
    expect(await screen.findByText(stat('4 followers'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unfollow @public_user' })).toHaveTextContent(
      'Following',
    );
    await user.click(screen.getByRole('button', { name: 'Unfollow @public_user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unfollow @public_user?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unfollow' }));
    expect(await screen.findByText(stat('3 followers'))).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Follow @public_user' }),
    ).toBeInTheDocument();
  });

  it('searches users with paginated results and opens a profile page with its posts', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/users/discover')) {
        if (url.searchParams.has('cursor')) {
          return jsonResponse({
            data: {
              users: [
                {
                  username: 'discover_b',
                  displayName: 'Discover B',
                  isPrivate: false,
                  followState: 'none',
                },
              ],
              nextCursor: null,
            },
          });
        }
        return jsonResponse({
          data: {
            users: [
              {
                username: 'discover_a',
                displayName: 'Discover A',
                isPrivate: false,
                followState: 'none',
              },
            ],
            nextCursor: 'discovery-cursor',
          },
        });
      }
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === 'discover_b') {
        return jsonResponse({
          data: {
            user: {
              username: 'discover_b',
              displayName: 'Discover B',
              bio: 'A discoverable bio',
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 3,
              followingCount: 2,
            },
          },
        });
      }
      if (url.pathname.endsWith('/users/discover_b/posts')) {
        if (url.searchParams.has('cursor')) {
          return jsonResponse({
            data: {
              posts: [{ ...feedPost, id: '66666666-6666-4666-8666-666666666666', caption: 'Next profile post' }],
              nextCursor: null,
            },
          });
        }
        return jsonResponse({
          data: { posts: [feedPost], nextCursor: 'profile-posts-cursor' },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'discover');
    expect(await screen.findByText('discover_a')).toBeInTheDocument();
    const firstSearch = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/users/discover?'),
    );
    expect(firstSearch?.[0]).toContain('q=discover');
    expect(firstSearch?.[1]?.credentials).toBe('include');

    await user.click(screen.getByRole('button', { name: 'Load more profiles' }));
    expect(await screen.findByText('discover_b')).toBeInTheDocument();
    const nextSearch = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('cursor=discovery-cursor'),
    );
    expect(nextSearch).toBeDefined();

    await user.click(screen.getByRole('button', { name: /discover_b/ }));
    expect(await screen.findByRole('heading', { name: 'discover_b' })).toBeInTheDocument();
    expect(screen.getByText('A discoverable bio')).toBeInTheDocument();
    expect(screen.getByText(stat('3 followers'))).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'A sunny afternoon' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more posts' }));
    expect(await screen.findByRole('img', { name: 'Next profile post' })).toBeInTheDocument();
  });

  it('keeps private profile details and posts hidden, with an explicit pending state', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/users/discover')) {
        return jsonResponse({
          data: {
            users: [
              {
                username: 'private_person',
                isPrivate: true,
                followState: 'pending',
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === 'private_person') {
        return jsonResponse({
          data: {
            user: {
              username: 'private_person',
              isPrivate: true,
              followState: 'pending',
              followerCount: null,
              followingCount: null,
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'private');
    await user.click(await screen.findByRole('button', { name: /private_person/ }));
    expect(await screen.findByText('This account is private')).toBeInTheDocument();
    expect(screen.getByText('Follow this account to see its posts.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel follow request to @private_person' }),
    ).toHaveTextContent('Requested');
    expect(screen.queryByText('Private biography')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'private_person' })).queryByText(stat('0 followers')),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith('/users/private_person/posts')),
    ).toBe(false);
  });

  it('shows discovery empty/error and profile not-found states with retries', async () => {
    const user = userEvent.setup();
    let searchAttempt = 0;
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/users/discover')) {
        searchAttempt += 1;
        if (searchAttempt === 1) return errorResponse(503, 'UNAVAILABLE', 'internal detail');
        if (url.searchParams.get('q') === 'missing') {
          return jsonResponse({
            data: {
              users: [
                { username: 'missing_user', isPrivate: false, followState: 'none' },
              ],
              nextCursor: null,
            },
          });
        }
        return jsonResponse({ data: { users: [], nextCursor: null } });
      }
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === 'missing_user') {
        return errorResponse(404, 'NOT_FOUND', 'private database detail');
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'nobody');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable. Please try again later.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(await screen.findByText('No profiles found.')).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/i)).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search usernames'));
    await user.type(screen.getByLabelText('Search usernames'), 'missing');
    await user.click(await screen.findByRole('button', { name: /missing_user/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Profile not found.');
    expect(screen.getByRole('button', { name: 'Retry profile' })).toBeInTheDocument();
    expect(screen.queryByText(/private database detail/i)).not.toBeInTheDocument();
  });

  it('shows loading and empty states while discovery runs', async () => {
    const user = userEvent.setup();
    let finishDiscovery!: (response: Response) => void;
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/users/discover')) {
        return new Promise<Response>((resolve) => {
          finishDiscovery = resolve;
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByLabelText('Search usernames'), 'loading');
    expect(await screen.findByText('Searching profiles…')).toBeInTheDocument();
    await waitFor(() => expect(finishDiscovery).toBeTypeOf('function'));
    finishDiscovery(
      jsonResponse({
        data: {
          users: [],
          nextCursor: null,
        },
      }),
    );
    expect(await screen.findByText('No profiles found.')).toBeInTheDocument();
  });

  it('loads notifications, displays authorized resource links, marks them read, and paginates', async () => {
    const user = userEvent.setup();
    const firstNotification = {
      id: '77777777-7777-4777-8777-777777777777',
      actorUsername: 'sunny_user',
      type: 'like',
      createdAt: '2026-10-21T12:00:00.000000Z',
      readAt: null,
      postId: feedPost.id,
      relatedUsername: null,
      resourceUrl: feedPost.imageUrl,
    };
    let notificationPages = 0;
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.includes('/notifications/') && init?.method === 'PUT') {
        return jsonResponse({ data: { readAt: '2026-10-22T00:00:00.000Z' } });
      }
      if (url.pathname.endsWith('/notifications')) {
        notificationPages += 1;
        return jsonResponse({
          data: {
            notifications:
              notificationPages === 1
                ? [firstNotification]
                : [
                    {
                      ...firstNotification,
                      id: '88888888-8888-4888-8888-888888888888',
                      type: 'follow_request',
                      postId: null,
                      resourceUrl: null,
                    },
                  ],
            nextCursor: notificationPages === 1 ? 'notifications-cursor' : null,
          },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<App />);
    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('sunny_user')).toBeInTheDocument();
    expect(screen.getByText('liked your post.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View post' })).toHaveAttribute(
      'href',
      `http://localhost:4000/api${feedPost.imageUrl}`,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as read' }));
    expect(await screen.findByLabelText('Read notification')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more notifications' }));
    expect(await screen.findByText('requested to follow you.')).toBeInTheDocument();
    expect(notificationPages).toBe(2);
  });

  it('shows notification loading, empty, error, and retry states', async () => {
    const user = userEvent.setup();
    let finishNotifications!: (response: Response) => void;
    let notificationRequests = 0;
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/notifications')) {
        notificationRequests += 1;
        if (notificationRequests === 1) {
          return new Promise<Response>((resolve) => {
            finishNotifications = resolve;
          });
        }
        if (notificationRequests === 2) {
          return errorResponse(503, 'UNAVAILABLE', 'Internal details must remain hidden.');
        }
        return jsonResponse({ data: { notifications: [], nextCursor: null } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<App />);
    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    finishNotifications(jsonResponse({ data: { notifications: [], nextCursor: null } }));
    expect(await screen.findByText('You have no notifications yet.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.queryByText('Internal details must remain hidden.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry notifications' }));
    expect(await screen.findByText('You have no notifications yet.')).toBeInTheDocument();
  });

  it('accepts a message request, marks it read, and prevents duplicate message submissions', async () => {
    const user = userEvent.setup();
    const conversationId = '99999999-9999-4999-8999-999999999999';
    let accepted = false;
    let finishSend!: (response: Response) => void;
    let messagePosts = 0;
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/conversations') && url.searchParams.get('limit') === '30') {
        return jsonResponse({
          data: {
            conversations: [
              {
                id: conversationId,
                username: 'message_sender',
                displayName: 'Message Sender',
                requestStatus: accepted ? 'accepted' : 'pending',
                requestedByMe: false,
                lastMessageAt: '2026-10-22T08:00:00.000Z',
                unreadCount: accepted ? 0 : 1,
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (
        url.pathname.endsWith(`/conversations/${conversationId}/messages`) &&
        init?.method !== 'POST'
      ) {
        const messages =
          messagePosts > 0
            ? [
                {
                  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  senderId: profile.id,
                  senderUsername: profile.username,
                  text: 'Thanks for the message.',
                  createdAt: '2026-10-22T08:05:00.000Z',
                },
              ]
            : [
                {
                  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  senderId: 'user-sender',
                  senderUsername: 'message_sender',
                  text: 'Hello there.',
                  createdAt: '2026-10-22T08:00:00.000Z',
                },
              ];
        return jsonResponse({ data: { messages, nextCursor: null } });
      }
      if (url.pathname.endsWith(`/conversations/${conversationId}/read`)) {
        return jsonResponse({ data: { read: true } });
      }
      if (url.pathname.endsWith(`/conversations/${conversationId}/accept`)) {
        accepted = true;
        return jsonResponse({ data: { requestStatus: 'accepted' } });
      }
      if (
        url.pathname.endsWith(`/conversations/${conversationId}/messages`) &&
        init?.method === 'POST'
      ) {
        messagePosts += 1;
        return new Promise<Response>((resolve) => {
          finishSend = resolve;
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);
    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    await user.click(await screen.findByRole('tab', { name: 'Requests (1)' }));
    await user.click(await screen.findByRole('button', { name: /message_sender/ }));
    expect(await screen.findByText('Hello there.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await user.type(await screen.findByLabelText('Message'), 'Thanks!');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(messagePosts).toBe(1);
    const requestCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith(`/conversations/${conversationId}/messages`) &&
        init?.method === 'POST',
    );
    expect(JSON.parse(String(requestCall?.[1]?.body))).toMatchObject({
      text: 'Thanks!',
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    finishSend(
      jsonResponse({
        data: {
          message: {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            senderId: profile.id,
            senderUsername: profile.username,
            text: 'Thanks!',
            createdAt: '2026-10-22T08:05:00.000Z',
          },
        },
      }, 201),
    );
    expect(await screen.findByText('Thanks for the message.')).toBeInTheDocument();
  });

  it('starts a message request with a trimmed first message and displays pending status', async () => {
    const user = userEvent.setup();
    const conversationId = '12121212-1212-4212-8212-121212121212';
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/conversations/target_user') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          text: 'Hello!',
          idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        });
        return jsonResponse({
          data: {
            conversation: {
              id: conversationId,
              requestStatus: 'pending',
              requestedByMe: true,
              created: true,
            },
          },
        }, 201);
      }
      if (url.pathname.endsWith('/conversations') && url.searchParams.get('limit') === '30') {
        return jsonResponse({
          data: {
            conversations: [
              {
                id: conversationId,
                username: 'target_user',
                displayName: 'target_user',
                requestStatus: 'pending',
                requestedByMe: true,
                lastMessageAt: '2026-10-22T08:00:00.000Z',
                unreadCount: 0,
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith(`/conversations/${conversationId}/messages`)) {
        return jsonResponse({
          data: {
            messages: [
              {
                id: 'abababab-abab-4bab-8bab-abababababab',
                senderId: profile.id,
                senderUsername: profile.username,
                text: 'Hello!',
                createdAt: '2026-10-22T08:00:00.000Z',
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith(`/conversations/${conversationId}/read`)) {
        return jsonResponse({ data: { read: true } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);
    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    await user.click(screen.getByRole('button', { name: 'New message' }));
    await user.type(screen.getByLabelText('Recipient username'), 'Target_User');
    await user.type(
      screen.getByLabelText('First message'),
      '  Hello!  ',
    );
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('Waiting for the recipient to accept your message request.')).toBeInTheDocument();
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('shows inbox loading and retries a failed conversation page', async () => {
    const user = userEvent.setup();
    let finishInbox!: (response: Response) => void;
    let cursorRequests = 0;
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/csrf')) return csrfResponse();
      if (url.pathname.endsWith('/users') && url.searchParams.get('username') === profile.username) {
        return jsonResponse({
          data: {
            user: {
              username: profile.username,
              displayName: profile.displayName,
              bio: profile.bio,
              avatarUrl: null,
              isPrivate: false,
              followState: 'none',
              followerCount: 0,
              followingCount: 0,
            },
          },
        });
      }
      if (url.pathname.endsWith('/conversations') && url.searchParams.has('cursor')) {
        cursorRequests += 1;
        if (cursorRequests === 1) {
          return errorResponse(503, 'UNAVAILABLE', 'Internal details must remain hidden.');
        }
        return jsonResponse({
          data: {
            conversations: [
              {
                id: '34343434-3434-4434-8434-343434343434',
                username: 'second_user',
                displayName: 'Second User',
                requestStatus: 'accepted',
                requestedByMe: false,
                lastMessageAt: '2026-10-22T09:00:00.000Z',
                unreadCount: 0,
              },
            ],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith('/conversations')) {
        return new Promise<Response>((resolve) => {
          finishInbox = resolve;
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);
    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.getByText('Loading inbox…')).toBeInTheDocument();
    finishInbox(
      jsonResponse({
        data: {
          conversations: [
            {
              id: '23232323-2323-4323-8323-232323232323',
              username: 'first_user',
              displayName: 'First User',
              requestStatus: 'accepted',
              requestedByMe: false,
              lastMessageAt: '2026-10-22T10:00:00.000Z',
              unreadCount: 0,
            },
          ],
          nextCursor: 'inbox-cursor',
        },
      }),
    );
    expect(await screen.findByRole('button', { name: /first_user/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more conversations' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
    expect(screen.queryByText('Internal details must remain hidden.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry conversations' }));
    expect(await screen.findByRole('button', { name: /second_user/ })).toBeInTheDocument();
    expect(cursorRequests).toBe(2);
  });
});

describe('live updates', () => {
  it('shows unread message and activity badges and clears the activity dot when opened', async () => {
    const user = userEvent.setup();
    inboxBadgeImplementation = () =>
      jsonResponse({ data: { unreadConversations: 2, requests: 1 } });
    notificationBadgeImplementation = () =>
      jsonResponse({ data: { count: 1, latestAt: new Date().toISOString() } });
    mockFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/me')) return authenticatedResponse();
      if (url.includes('/notifications?')) {
        return jsonResponse({ data: { notifications: [], nextCursor: null } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);

    const messages = await screen.findByRole('button', { name: 'Messages' });
    await waitFor(() => expect(messages).toHaveAccessibleDescription('2 unread conversations'));
    const notifications = screen.getByRole('button', { name: 'Notifications' });
    expect(notifications).toHaveAccessibleDescription('New activity');

    await user.click(notifications);
    await waitFor(() => expect(notifications).not.toHaveAccessibleDescription('New activity'));
  });

  it('refreshes like and comment counts and offers newly published posts', async () => {
    const user = userEvent.setup();
    mockFetch(async (input) => {
      if (String(input).endsWith('/auth/me')) return authenticatedResponse();
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const newerPost = {
      ...feedPost,
      id: '77777777-7777-4777-8777-777777777777',
      caption: 'Fresh from the oven',
      createdAt: '2026-10-22T12:00:00.000000Z',
    };
    feedFetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(feedResponse([{ ...feedPost, commentCount: 0 }]))
      .mockResolvedValue(
        feedResponse([newerPost, { ...feedPost, likeCount: 5, commentCount: 3 }]),
      );
    render(<App />);

    expect(await screen.findByText('A sunny afternoon')).toBeInTheDocument();
    expect(screen.getByText('0 likes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View/ })).not.toBeInTheDocument();

    triggerPolls();

    expect(await screen.findByText('5 likes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View all 3 comments' })).toBeInTheDocument();
    expect(screen.queryByText('Fresh from the oven')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1 new post' }));
    expect(screen.getByText('Fresh from the oven')).toBeInTheDocument();
  });

  it('shows an incoming message request without reloading the inbox', async () => {
    const user = userEvent.setup();
    let inboxLoads = 0;
    mockFetch(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth/me')) return authenticatedResponse();
      if (url.pathname.endsWith('/conversations')) {
        inboxLoads += 1;
        return jsonResponse({
          data: {
            conversations:
              inboxLoads === 1
                ? []
                : [
                    {
                      id: '45454545-4545-4545-8545-454545454545',
                      username: 'new_friend',
                      displayName: 'New Friend',
                      requestStatus: 'pending',
                      requestedByMe: false,
                      lastMessageAt: '2026-10-22T08:00:00.000Z',
                      unreadCount: 1,
                    },
                  ],
            nextCursor: null,
          },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<App />);

    await screen.findByText('Rubaagram User');
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument();

    triggerPolls();

    expect(await screen.findByText('1 person wants to message you')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Requests (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Message requests/ }));
    expect(await screen.findByRole('button', { name: /new_friend/ })).toBeInTheDocument();
  });
});
