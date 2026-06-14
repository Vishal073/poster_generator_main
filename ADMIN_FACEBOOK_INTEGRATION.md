# Admin portal — Facebook integration

Backend is ready. Add the following in your admin portal (Vite/React on port 5173).

## Flow

```
User list → [Facebook] button per row (uses user._id)
        ↓
GET /auth/facebook?userId=USER_ID  (full page redirect)
        ↓
OAuth → save tokens linked to userId
        ↓
/facebook/pages?sessionId=...&userId=...  → select Page → POST /facebook/save-page
        ↓
Generate poster → uploadToFacebook: true → auto post to saved Page
```

## 1. User list — Facebook button

`GET /users` now returns per user:

```json
{
  "_id": "6789...",
  "name": "Rahul",
  "facebook": {
    "facebookConnected": true,
    "facebookPageSelected": true,
    "facebookPageName": "ScoobyDooby"
  }
}
```

### Button in each row

```jsx
const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

function FacebookButton({ user }) {
  const fb = user.facebook || {};
  const label = fb.facebookPageSelected
    ? `Facebook: ${fb.facebookPageName}`
    : fb.facebookConnected
      ? "Select Facebook Page"
      : "Connect Facebook";

  return (
    <a
      href={`${API}/auth/facebook?userId=${user._id}`}
      className="btn"
      target="_self"
    >
      {label}
    </a>
  );
}
```

Or fetch connect URL:

```js
const { data } = await axios.get(`${API}/facebook/connect-url/${user._id}`);
window.location.href = data.connectUrl;
```

## 2. Page selection page (`/facebook/pages`)

After OAuth redirect, read query params and save Page:

```jsx
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId");
const userId = params.get("userId");

// Load pages
const { data } = await axios.get(`${API}/facebook/pages`, { params: { sessionId } });

// On user pick
await axios.post(`${API}/facebook/save-page`, { sessionId, pageId: selectedPageId });
```

## 3. Generate poster — one-click Facebook upload

### Single poster

```js
POST /generate-poster
{
  "userId": "6789...",
  "posterSource": "https://res.cloudinary.com/.../base.jpg",
  "textLines": ["..."],
  "uploadToFacebook": true,
  "facebookCaption": "Optional caption"
}
```

Response includes:

```json
{
  "success": true,
  "imageUrl": "https://res.cloudinary.com/.../poster.png",
  "facebook": {
    "success": true,
    "postId": "...",
    "pageName": "ScoobyDooby"
  }
}
```

If user not connected:

```json
"facebook": { "success": false, "message": "This user has not connected Facebook yet." }
```

### Bulk posters

```js
POST /generate-posters/bulk
{
  "userIds": ["id1", "id2"],
  "posterSource": "...",
  "uploadToFacebook": true
}
```

Each success result may include `facebook: { success, postId, ... }`.

## 4. Post existing image (without regenerate)

```js
POST /facebook/post-for-user
{
  "userId": "6789...",
  "imageUrl": "https://res.cloudinary.com/.../poster.png",
  "caption": "Hello"
}
```

## API summary

| Method | Path | Use |
|--------|------|-----|
| GET | `/auth/facebook?userId=` | Connect Facebook (redirect) |
| GET | `/facebook/connect-url/:userId` | Get connect URL JSON |
| GET | `/facebook/connection/:userId` | Check if user linked |
| GET | `/facebook/pages?sessionId=` | List pages after OAuth |
| POST | `/facebook/save-page` | Save selected Page |
| GET | `/facebook/posts/:userId` | List recent posts on saved Page |
| DELETE | `/facebook/posts/:userId/:postId` | Delete a post from saved Page |
| POST | `/facebook/post-for-user` | One-click post by userId |
| POST | `/generate-poster` | `uploadToFacebook: true` |

## Env (admin portal)

```env
VITE_API_URL=http://localhost:5000
```
