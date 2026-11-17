import axios from "axios";

/**
 * In-Memory Token Storage
 * Access token memory mein rehta hai (no localStorage/sessionStorage)
 */
let inMemoryAccessToken = null;

export function getAccessToken() {
  return inMemoryAccessToken;
}

export function setAccessToken(token) {
  inMemoryAccessToken = token;
}

export function clearAccessToken() {
  inMemoryAccessToken = null;
}

const API_BASE_URL =
  import.meta.env.VITE_API_URL || "http://localhost:8602";

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // Refresh token cookie bhejne ke liye zaroori hai
  headers: {
    "Content-Type": "application/json",
  },
});

let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Request Interceptor: Access token header mein attach karta hai
apiClient.interceptors.request.use(
  (config) => {
    const token = getAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response Interceptor: 401 TOKEN_EXPIRED aane par refresh karta hai aur queue banata hai
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    const isTokenExpired =
      error.response &&
      error.response.status === 401 &&
      error.response.data &&
      error.response.data.error &&
      error.response.data.error.code === "TOKEN_EXPIRED";

    if (isTokenExpired && originalRequest && !originalRequest._retry) {
      if (isRefreshing) {
        // Refresh pehle se chal raha hai: queue mein add karo
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return apiClient(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // /auth/refresh call karo withCredentials ke sath
        const response = await axios.post(
          `${API_BASE_URL}/auth/refresh`,
          {},
          { withCredentials: true }
        );

        const newAccessToken = response.data.accessToken;
        setAccessToken(newAccessToken);

        // Sabhi queued requests ko naye token ke sath chalao
        processQueue(null, newAccessToken);

        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        }

        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        clearAccessToken();

        // Login page par redirect
        if (typeof window !== "undefined") {
          window.location.href = "/login?expired=true";
        }

        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default apiClient;
