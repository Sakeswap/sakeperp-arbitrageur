FROM node:14.15.1

RUN mkdir -p /usr/src/app

WORKDIR /usr/src/app

COPY package.json /usr/src/app

RUN npm install

RUN npm install @types/fs-extra

COPY . /usr/src/app

RUN npm run build