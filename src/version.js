// The build shown in the corner of the menu and the pause screen, so players
// can tell which version is live. A static site can't know its own commit
// hash, so this is the commit count instead: the number of commits up to and
// including the one that sets it (`git rev-list --count HEAD` on that commit).
// Bump it in every commit that gets pushed.
export const BUILD = 157;
