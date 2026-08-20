export const SOURCES = {
  campingCarPark: {
    id: 'camping-car-park', name: 'Camping-Car Park', enabled: true,
    mode: 'public-web', baseUrl: 'https://www.campingcarpark.com'
  },
  park4night: {
    id: 'park4night', name: 'Park4night', enabled: false,
    mode: 'disabled-until-authorized', baseUrl: 'https://park4night.com'
  }
};

export function sourceList() {
  return Object.values(SOURCES).map(({id,name,enabled,mode,baseUrl}) => ({id,name,enabled,mode,baseUrl}));
}
