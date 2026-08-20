# Navbar logos

Two image files, dropped in this folder on the server. No code change is needed.

| File (any of these extensions) | Where it appears            |
| ------------------------------ | --------------------------- |
| `public/logo-bluderma.*`       | navbar, left                |
| `public/logo-madenkorea.*`     | navbar, right (from ~640px) |

`.png` is tried first, then `.jpg`, then `.svg`, so whichever you saved works.
Filenames are case-sensitive on Linux: `Logo-BluDerma.png` will not be found.

Both are drawn on a white plate, so artwork on a white or transparent background
is what you want. They are sized by height (20px on phones, 28px above), so any
width is fine — wide wordmarks are the expected shape.

## Getting them onto the server

    scp logo-bluderma.png   deploy@your-server:~/meetings-app/public/
    scp logo-madenkorea.png deploy@your-server:~/meetings-app/public/

Then check they are actually served, which is the part worth verifying:

    curl -o /dev/null -w '%{http_code}\n' https://meetings.raceinnovations.in/logo-bluderma.png

200 means the navbar will show it. 404 means the file is not where the server is
looking — check the folder, the spelling and the capitalisation. A rebuild is not
required for a new file in this folder, but a hard refresh in the browser is,
since the page itself is cached.
