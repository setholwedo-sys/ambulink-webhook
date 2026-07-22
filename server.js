const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON payloads
app.use(express.json());

// Helper function: Haversine Formula to calculate distance (in km) between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
}

// Initial array of partner hospitals
let partnerHospitals = [
  {
    hospital_id: "hosp_kawolo_ug_01",
    name: "Kawolo General Hospital",
    facility_type: "Public General Hospital",
    category: "Trauma & Emergency Center",
    location: {
      district: "Buikwe",
      town: "Lugazi",
      address: "Kampala-Jinja Highway",
      coordinates: {
        latitude: 0.368050,
        longitude: 32.945553
      }
    },
    emergency_services: {
      trauma_unit: true,
      icu_capable: true,
      operating_theaters: true,
      ambulance_station: true
    },
    dispatch_status: "AVAILABLE"
  },
  {
    hospital_id: "hosp_jinja_ug_02",
    name: "Jinja Regional Referral Hospital",
    facility_type: "Regional Referral Hospital",
    category: "Major Referral & Trauma Center",
    location: {
      district: "Jinja",
      town: "Jinja City",
      address: "Nalufenya Road",
      coordinates: {
        latitude: 0.428300,
        longitude: 33.203600
      }
    },
    emergency_services: {
      trauma_unit: true,
      icu_capable: true,
      operating_theaters: true,
      ambulance_station: true
    },
    dispatch_status: "AVAILABLE"
  }
];

// 1. GET: Fetch all partner hospitals
app.get('/api/v1/hospitals', (req, res) => {
  res.status(200).json({
    success: true,
    count: partnerHospitals.length,
    data: partnerHospitals
  });
});

// 2. GET: Fetch a single hospital by ID
app.get('/api/v1/hospitals/:id', (req, res) => {
  const hospital = partnerHospitals.find(h => h.hospital_id === req.params.id);
  
  if (!hospital) {
    return res.status(404).json({
      success: false,
      message: "Hospital not found"
    });
  }

  res.status(200).json({
    success: true,
    data: hospital
  });
});

// 3. POST: Add a new partner hospital dynamically
app.post('/api/v1/hospitals', (req, res) => {
  const newHospital = req.body;

  if (!newHospital.hospital_id || !newHospital.name) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: 'hospital_id' and 'name' are required."
    });
  }

  partnerHospitals.push(newHospital);

  res.status(201).json({
    success: true,
    message: "Partner hospital added successfully",
    data: newHospital
  });
});

// 4. POST: Webhook Dispatch Endpoint (Calculates nearest available hospital)
app.post('/api/v1/dispatch', (req, res) => {
  const { incident_id, location, emergency_type } = req.body;

  // Validate incoming payload coordinates
  if (!location || location.latitude === undefined || location.longitude === undefined) {
    return res.status(400).json({
      success: false,
      message: "Invalid dispatch payload: 'location' with 'latitude' and 'longitude' is required."
    });
  }

  // Filter hospitals that are available
  const availableHospitals = partnerHospitals.filter(h => h.dispatch_status === "AVAILABLE");

  if (availableHospitals.length === 0) {
    return res.status(503).json({
      success: false,
      message: "No available partner hospitals at this moment."
    });
  }

  // Calculate distance to each hospital and find the closest one
  let nearestHospital = null;
  let shortestDistance = Infinity;

  availableHospitals.forEach(hospital => {
    const dist = calculateDistance(
      location.latitude,
      location.longitude,
      hospital.location.coordinates.latitude,
      hospital.location.coordinates.longitude
    );

    if (dist < shortestDistance) {
      shortestDistance = dist;
      nearestHospital = hospital;
    }
  });

  // Construct response payload
  const dispatchAssignment = {
    dispatch_id: `disp_${Date.now()}`,
    incident_id: incident_id || `inc_${Math.floor(Math.random() * 10000)}`,
    emergency_type: emergency_type || "General Emergency",
    status: "DISPATCHED",
    timestamp: new Date().toISOString(),
    assigned_hospital: {
      hospital_id: nearestHospital.hospital_id,
      name: nearestHospital.name,
      town: nearestHospital.location.town,
      district: nearestHospital.location.district
    },
    distance_km: parseFloat(shortestDistance.toFixed(2)),
    estimated_eta_minutes: Math.ceil(shortestDistance * 2) // Estimated ~2 mins per km
  };

  res.status(200).json({
    success: true,
    message: "Emergency dispatch assigned to nearest hospital",
    data: dispatchAssignment
  });
});

// Root route
app.get('/', (req, res) => {
  res.send('Ambulink Webhook API is running...');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
