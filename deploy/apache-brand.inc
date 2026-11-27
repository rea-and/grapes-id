# GrapesID sign-in branding. Installed as /etc/apache2/grapesid-brand.inc by deploy/brand.sh and pulled into the GrapesID
# virtual hosts with `IncludeOptional`. To switch the branding off: delete that Include line (or this file) and reload
# Apache; the sign-in pages go back to Zitadel's default look.
#
# It does two things for the sign-in pages (/ui/v2/login) only: serves the files in branding/ under /ui/v2/login/brand/,
# and adds one <link> to the stylesheet to every HTML page. The admin console is untouched.

# Must come before the ProxyPass that sends /ui/v2/login to the login container.
ProxyPass /ui/v2/login/brand !
Alias /ui/v2/login/brand/ /var/www/grapesid-brand/

<Directory /var/www/grapesid-brand>
    Require all granted
    Options -Indexes
    # Short cache so style tweaks show up within minutes; the fonts never change.
    Header set Cache-Control "public, max-age=300"
    <FilesMatch "\.woff2$">
        Header set Cache-Control "public, max-age=2592000"
    </FilesMatch>
</Directory>

# Pages only: the app's own scripts and styles (/_next/...) and our files (/brand/...) pass through untouched and stay compressed.
<LocationMatch "^/ui/v2/login/(?!(_next|brand)/)">
    # Ask the login container for plain (uncompressed) HTML so it can be rewritten on the way through.
    RequestHeader unset Accept-Encoding
    AddOutputFilterByType SUBSTITUTE text/html
    Substitute "s|</head>|<link rel=\"stylesheet\" href=\"/ui/v2/login/brand/grapesid.css\"></head>|i"
</LocationMatch>
