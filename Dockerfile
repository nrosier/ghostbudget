# Gebruik Node 22 Alpine voor een kleine en veilige image
FROM node:22-alpine

# Stel de werkmap in
WORKDIR /app

# Kopieer eerst de package-bestanden om optimaal gebruik te maken van Docker caching
COPY package*.json ./

# Installeer alleen de noodzakelijke productie-dependencies
RUN npm install --omit=dev

# Kopieer de rest van de applicatiecode
COPY . .

# Maak een dummy .env bestand aan als het niet bestaat (voorkomt crashes bij build)
# Je injecteert je echte variabelen tijdens 'docker run' of via docker-compose
RUN touch .env

# Het commando om de synchronisatie uit te voeren
CMD ["npm", "run", "sync"]
