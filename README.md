# AWS Session FIFO · v0.8.0

Chrome Manifest V3 extension for AWS Console's five simultaneous-identity limit.
This release builds on the user's working v0.7 flow with **zero configuration** and a new multi-account rotation icon.

## Install / upgrade

1. Extract the ZIP to a folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. If v0.7 is installed from a different folder, remove the old extension to avoid two copies running simultaneously.
4. Choose **Load unpacked** and select the extracted `aws-session-fifo-v0.8` folder.
5. That's it. No toggles or settings. Start account sign-ins from your AWS IAM Identity Center access portal (an `*.awsapps.com` page).

**Upgrading in place:** You may overwrite the files in the old unpacked extension directory with v0.8's contents and click **Reload** in `chrome://extensions`. Chrome keeps the extension ID when reloading the same unpacked folder.

## Automatic workflow

1. You click an account/role in the AWS access portal. The extension remembers the clicked element in the portal tab's page memory for a few minutes, without storing federation tokens.
2. If AWS shows `Session limit reached`, the extension reads the five session ages displayed by AWS, selects the oldest, and clicks AWS's sign-out-and-continue link.
3. After AWS explicitly confirms the sign-out, the extension attempts the original portal click once more, then closes the sign-out-result tab.
4. When it sees a new Console identity after the retry, it unlocks the next replacement automatically.

The toolbar popup is now **read-only**: no tracking list, counters, toggles or recovery buttons. Automatic mode and retries are **always enabled**. Internal short-lived observations are stored only in Chrome `storage.session`, not in persistent local storage. Upgrading deletes the previous extension's `aws_fifo_state` local-storage key.

## Limits and safety

- The original IAM Identity Center portal tab should remain open for the automatic retry.
- A programmatic click can be blocked by browser/portal security. If that happens, manually choose the account again in the portal; the extension cannot guarantee retry success.
- A failed retry that reaches the five-session limit again will **not** automatically sign out a second account in the same attempt. A fresh real portal click resets that safety stop, and the guard also expires after two minutes.
- AWS's login age labels are rounded; equal-age ties select the first row.
- If the flow stops, open Chrome DevTools for the affected AWS limit page (Console) or `chrome://extensions` → extension → Service worker (Inspect), and look for `[AWS Session FIFO]` logs. Do not send authentication tokens or cookies.
- No cookie-reading, credential access, or SAML/OAuth/federation-URL replay is implemented.

Icons are included as PNGs for Chrome and as an editable source SVG in `icons/orbit.svg`.
