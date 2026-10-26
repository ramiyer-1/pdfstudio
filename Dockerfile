# PDF Studio: static site served by nginx.
#   docker build -t pdf-studio .
#   docker run -d --name pdf-studio -p 8080:80 --restart unless-stopped pdf-studio
FROM nginx:1.27-alpine
COPY deploy/nginx-docker.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js editor.js /usr/share/nginx/html/
COPY vendor /usr/share/nginx/html/vendor
EXPOSE 80
